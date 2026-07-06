import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { strict as assert } from 'node:assert';
import BigNumber from 'bignumber.js';
import type { ParsedPayload } from '@pythnetwork/pyth-lazer-sdk';
import { PriceUpdatePlanner } from '../src/relayer/price-update-planner.ts';
import type {
  ContractSymbolPriceReader,
  OnChainPrice,
} from '../src/relayer/contract-symbol-price-reader.ts';
import type {
  PriceUpdateTransactionSubmitter,
  SubmitResult,
} from '../src/relayer/price-update-transaction-submitter.ts';

/** A signed payload stand-in; its bytes are irrelevant to the planner. */
const DUMMY_EVM = Buffer.from([0xab, 0xcd]);

/** Resolves after the microtask + immediate queues drain (lets fired promises settle). */
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Builds a parsed payload with the given timestamp (µs) and feeds. */
function makePayload(timestampUs: number, feeds: Array<{ id: number; price?: string }>): ParsedPayload {
  return {
    timestampUs: String(timestampUs),
    priceFeeds: feeds.map(({ id, price }) => ({ priceFeedId: id, price })),
  } as unknown as ParsedPayload;
}

/** An on-chain baseline record for the fake reader. */
function baseline(price: number, publishTimeUs = 1_000): OnChainPrice {
  return { price: new BigNumber(price), publishTime: BigInt(publishTimeUs) };
}

interface SetupOptions {
  prices: Record<number, OnChainPrice | null>;
  heartbeatMs?: number;
  minSubmitIntervalMs?: number;
  deviationBps?: number;
  submitImpl?: (evm: Buffer) => Promise<SubmitResult>;
}

function setup(opts: SetupOptions) {
  const getPriceFn = mock.fn(async (feedId: number) => opts.prices[feedId] ?? null);
  const getStaleFn = mock.fn(async (): Promise<bigint | null> => null);
  const reader = {
    getPrice: getPriceFn,
    getStalePriceThresholdSeconds: getStaleFn,
  } as unknown as ContractSymbolPriceReader;

  const submitFn = mock.fn(
    opts.submitImpl ?? (async (): Promise<SubmitResult> => ({ ok: true, txId: '0x1' }))
  );
  const submitter = { submit: submitFn } as unknown as PriceUpdateTransactionSubmitter;

  const planner = new PriceUpdatePlanner({
    reader,
    submitter,
    heartbeatMs: opts.heartbeatMs ?? 100_000,
    minSubmitIntervalMs: opts.minSubmitIntervalMs ?? 1_000,
    deviationBps: opts.deviationBps ?? 50, // 0.5%
  });

  return { planner, submitFn, getPriceFn, getStaleFn };
}

/** Hands one streamed update to the planner and lets any fired async work settle. */
async function deliver(planner: PriceUpdatePlanner, payload: ParsedPayload, evm: Buffer = DUMMY_EVM) {
  planner.handlePriceMonitorPayload(evm, payload);
  await flush();
}

describe('PriceUpdatePlanner', () => {
  beforeEach(() => {
    // Mock only Date so cadence/heartbeat math is deterministic; leave timers
    // real so `flush()` can drain promise callbacks via setImmediate.
    mock.timers.enable({ apis: ['Date'], now: 0 });
  });

  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  test('seeds a baseline once and does not submit when the price matches it', async () => {
    const { planner, submitFn, getPriceFn } = setup({ prices: { 1: baseline(100) } });

    mock.timers.setTime(2_000); // past the cadence floor (construction was at t=0)

    // First sight: baseline is still resolving, so no decision is made yet.
    await deliver(planner, makePayload(2_000_000, [{ id: 1, price: '100' }]));
    assert.equal(submitFn.mock.callCount(), 0);

    // Baseline now resolved to 100; an equal price is not a deviation.
    await deliver(planner, makePayload(3_000_000, [{ id: 1, price: '100' }]));

    assert.equal(submitFn.mock.callCount(), 0);
    assert.equal(getPriceFn.mock.callCount(), 1, 'baseline read only once per feed');
  });

  test('submits when a feed deviates beyond the threshold', async () => {
    const { planner, submitFn } = setup({ prices: { 1: baseline(100) }, deviationBps: 50 });
    const evm = Buffer.from([0x01, 0x02, 0x03]);

    mock.timers.setTime(2_000);
    await deliver(planner, makePayload(2_000_000, [{ id: 1, price: '100' }])); // seed
    await deliver(planner, makePayload(3_000_000, [{ id: 1, price: '101' }]), evm); // +1% > 0.5%

    assert.equal(submitFn.mock.callCount(), 1);
    assert.deepEqual(submitFn.mock.calls[0]?.arguments[0], evm, 'submits the latest evm payload');
  });

  test('does not submit when deviation is below the threshold', async () => {
    const { planner, submitFn } = setup({ prices: { 1: baseline(100) }, deviationBps: 200 }); // 2%

    mock.timers.setTime(2_000);
    await deliver(planner, makePayload(2_000_000, [{ id: 1, price: '100' }])); // seed
    await deliver(planner, makePayload(3_000_000, [{ id: 1, price: '101' }])); // +1% < 2%

    assert.equal(submitFn.mock.callCount(), 0);
  });

  test('submits to establish a feed that has never been published on-chain', async () => {
    const { planner, submitFn } = setup({ prices: { 1: null } });

    mock.timers.setTime(2_000);
    await deliver(planner, makePayload(2_000_000, [{ id: 1, price: '100' }])); // seed -> null
    await deliver(planner, makePayload(3_000_000, [{ id: 1, price: '100' }])); // no baseline -> due

    assert.equal(submitFn.mock.callCount(), 1);
  });

  test('forces a submit on heartbeat even when prices are flat', async () => {
    const { planner, submitFn } = setup({
      prices: { 1: baseline(100) },
      heartbeatMs: 5_000,
      minSubmitIntervalMs: 1_000,
    });

    mock.timers.setTime(2_000);
    await deliver(planner, makePayload(2_000_000, [{ id: 1, price: '100' }])); // seed
    await deliver(planner, makePayload(3_000_000, [{ id: 1, price: '100' }])); // 2s < 5s heartbeat
    assert.equal(submitFn.mock.callCount(), 0);

    mock.timers.setTime(6_000); // 6s >= 5s heartbeat
    await deliver(planner, makePayload(4_000_000, [{ id: 1, price: '100' }]));
    assert.equal(submitFn.mock.callCount(), 1);
  });

  test('respects the minimum submit interval between submissions', async () => {
    const { planner, submitFn } = setup({
      prices: { 1: baseline(100) },
      minSubmitIntervalMs: 1_000,
      deviationBps: 50,
    });

    mock.timers.setTime(2_000);
    await deliver(planner, makePayload(2_000_000, [{ id: 1, price: '100' }])); // seed
    await deliver(planner, makePayload(3_000_000, [{ id: 1, price: '101' }])); // submit #1
    assert.equal(submitFn.mock.callCount(), 1);

    // Still within the cadence floor of submit #1 (also at t=2000).
    await deliver(planner, makePayload(4_000_000, [{ id: 1, price: '102' }]));
    assert.equal(submitFn.mock.callCount(), 1);

    mock.timers.setTime(3_001); // > 1s after submit #1
    await deliver(planner, makePayload(5_000_000, [{ id: 1, price: '103' }]));
    assert.equal(submitFn.mock.callCount(), 2);
  });

  test('ignores updates whose publish-time is not newer than the last submitted', async () => {
    const { planner, submitFn } = setup({ prices: { 1: baseline(100) }, deviationBps: 50 });

    mock.timers.setTime(2_000);
    await deliver(planner, makePayload(2_000_000, [{ id: 1, price: '100' }])); // seed
    await deliver(planner, makePayload(3_000_000, [{ id: 1, price: '105' }])); // submit @ ts 3e6
    assert.equal(submitFn.mock.callCount(), 1);

    mock.timers.setTime(4_000); // past cadence floor
    // Equal timestamp, despite a big price jump -> rejected as not newer.
    await deliver(planner, makePayload(3_000_000, [{ id: 1, price: '200' }]));
    assert.equal(submitFn.mock.callCount(), 1);
  });

  test('does not start a second submission while one is in flight', async () => {
    let release: (r: SubmitResult) => void = () => {};
    const submitImpl = () => new Promise<SubmitResult>(resolve => (release = resolve));
    const { planner, submitFn } = setup({
      prices: { 1: baseline(100) },
      deviationBps: 50,
      submitImpl,
    });

    mock.timers.setTime(2_000);
    await deliver(planner, makePayload(2_000_000, [{ id: 1, price: '100' }])); // seed
    await deliver(planner, makePayload(3_000_000, [{ id: 1, price: '101' }])); // submit #1 (pending)
    assert.equal(submitFn.mock.callCount(), 1);

    mock.timers.setTime(4_000); // past cadence floor, but a submit is in flight
    await deliver(planner, makePayload(4_000_000, [{ id: 1, price: '102' }]));
    assert.equal(submitFn.mock.callCount(), 1, 'no second submit while in flight');

    release({ ok: true, txId: '0x1' });
    await flush();
  });

  test('does not advance the baseline when a submission fails', async () => {
    const { planner, submitFn } = setup({
      prices: { 1: baseline(100) },
      deviationBps: 50,
      submitImpl: async () => ({ ok: false, error: 'boom' }),
    });

    mock.timers.setTime(2_000);
    await deliver(planner, makePayload(2_000_000, [{ id: 1, price: '100' }])); // seed
    await deliver(planner, makePayload(3_000_000, [{ id: 1, price: '101' }])); // submit #1 fails
    assert.equal(submitFn.mock.callCount(), 1);

    // Baseline still 100 (not advanced) and last-submitted ts not advanced, so the
    // next deviating update submits again rather than being suppressed.
    await deliver(planner, makePayload(4_000_000, [{ id: 1, price: '101' }]));
    assert.equal(submitFn.mock.callCount(), 2);
  });

  test('requestImmediateUpdate forces one submit regardless of deviation', async () => {
    const { planner, submitFn } = setup({
      prices: { 1: baseline(100) },
      minSubmitIntervalMs: 1_000,
    });

    mock.timers.setTime(2_000);
    await deliver(planner, makePayload(2_000_000, [{ id: 1, price: '100' }])); // seed

    planner.requestImmediateUpdate();
    await deliver(planner, makePayload(3_000_000, [{ id: 1, price: '100' }])); // forced, flat price
    assert.equal(submitFn.mock.callCount(), 1);

    // Force is consumed: a later flat update does not submit.
    mock.timers.setTime(3_001);
    await deliver(planner, makePayload(4_000_000, [{ id: 1, price: '100' }]));
    assert.equal(submitFn.mock.callCount(), 1);
  });

  test('handles a batch where only one of several feeds deviates', async () => {
    const { planner, submitFn } = setup({
      prices: { 1: baseline(100), 2: baseline(50) },
      deviationBps: 50,
    });

    mock.timers.setTime(2_000);
    await deliver(
      planner,
      makePayload(2_000_000, [
        { id: 1, price: '100' },
        { id: 2, price: '50' },
      ])
    ); // seed both
    await deliver(
      planner,
      makePayload(3_000_000, [
        { id: 1, price: '100' }, // flat
        { id: 2, price: '51' }, // +2% > 0.5%
      ])
    );

    assert.equal(submitFn.mock.callCount(), 1);
  });

  describe('validateHeartbeat', () => {
    test('warns when the heartbeat is not shorter than the stale-price threshold', async () => {
      const { planner, getStaleFn } = setup({ prices: {}, heartbeatMs: 30_000 });
      getStaleFn.mock.mockImplementation(async () => 10n); // 10s = 10_000ms <= 30_000ms
      const warn = mock.method((await import('@stacks/api-toolkit')).logger, 'warn', () => {});

      await planner.validateHeartbeat();

      assert.equal(getStaleFn.mock.callCount(), 1);
      assert.equal(warn.mock.callCount(), 1);
    });

    test('does not warn when the heartbeat is shorter than the threshold', async () => {
      const { planner, getStaleFn } = setup({ prices: {}, heartbeatMs: 30_000 });
      getStaleFn.mock.mockImplementation(async () => 120n); // 120s = 120_000ms > 30_000ms
      const warn = mock.method((await import('@stacks/api-toolkit')).logger, 'warn', () => {});

      await planner.validateHeartbeat();

      assert.equal(warn.mock.callCount(), 0);
    });
  });
});
