import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { strict as assert } from 'node:assert';

/**
 * Shared, test-tunable state the mocked SDK reads at call time.
 */
const ESTIMATED_FEE = 1_000n;
let confirmedNonce = 0n;
// The node returns a bare-hex txid; the submitter prefixes it with `0x`.
let broadcastResult: unknown = { txid: 'tx' };

/** Mocked `@stacks/transactions`. */
const makeContractCallFn = mock.fn(async (opts: any) => ({
  // `auth.spendingCondition.fee` is what the submitter reads as the broadcast
  // fee: the explicit fee if given, otherwise a simulated estimate.
  auth: { spendingCondition: { fee: opts.fee != null ? BigInt(opts.fee) : ESTIMATED_FEE } },
}));
const broadcastFn = mock.fn(async () => broadcastResult);
const getAddressFromPrivateKeyFn = mock.fn(() => 'ST_SENDER');
const Cl = {
  buffer: (bytes: unknown) => ({ kind: 'buffer', bytes }),
  contractPrincipal: (address: string, name: string) => ({ kind: 'contract', address, name }),
};

mock.module('@stacks/transactions', {
  namedExports: {
    Cl,
    makeContractCall: makeContractCallFn,
    broadcastTransaction: broadcastFn,
    getAddressFromPrivateKey: getAddressFromPrivateKeyFn,
  },
});

/** Mocked `@stacks/rpc-client`: the nonce read goes through this. */
const requestFn = mock.fn(async () => ({ nonce: Number(confirmedNonce) }));
const createCoreRpcClientFn = mock.fn(() => ({ request: requestFn }));

mock.module('@stacks/rpc-client', {
  namedExports: { createCoreRpcClient: createCoreRpcClientFn },
});

const { PriceUpdateTransactionSubmitter } = await import(
  '../src/relayer/price-update-transaction-submitter.ts'
);

const BASE_OPTS = {
  senderKey: '0xkey',
  network: 'testnet' as const,
  deployer: 'ST_DEPLOYER',
  rpcBaseUrl: 'http://node',
  feeBumpPercent: 25,
};

const EVM = Buffer.from([0xaa, 0xbb]);

function newSubmitter(over: Partial<typeof BASE_OPTS> & { txFeeMicroStx?: number; maxFeeMicroStx?: number } = {}) {
  return new PriceUpdateTransactionSubmitter({ ...BASE_OPTS, ...over });
}

/** The options of the most recent `makeContractCall`. */
function lastCallOpts(): any {
  const { calls } = makeContractCallFn.mock;
  return calls[calls.length - 1]?.arguments[0];
}

describe('PriceUpdateTransactionSubmitter', () => {
  beforeEach(() => {
    confirmedNonce = 0n;
    broadcastResult = { txid: 'tx' };
    makeContractCallFn.mock.resetCalls();
    broadcastFn.mock.resetCalls();
    requestFn.mock.resetCalls();
    getAddressFromPrivateKeyFn.mock.resetCalls();
  });

  afterEach(() => {
    mock.timers.reset();
  });

  test('builds and broadcasts a fresh tx at the confirmed nonce', async () => {
    confirmedNonce = 5n;
    broadcastResult = { txid: 'abc123' };
    const result = await newSubmitter().submit(EVM);

    assert.deepEqual(result, { ok: true, txId: '0xabc123' });

    const opts = lastCallOpts();
    assert.equal(opts.nonce, 5n);
    assert.equal(opts.contractAddress, 'ST_DEPLOYER');
    assert.equal(opts.contractName, 'pyth-lazer-oracle-v1');
    assert.equal(opts.functionName, 'verify-and-update-price-feeds');
    assert.equal(opts.postConditionMode, 'allow');
    assert.equal(opts.functionArgs.length, 2);
    assert.deepEqual(opts.functionArgs[0], { kind: 'buffer', bytes: EVM });
    assert.deepEqual(opts.functionArgs[1], {
      kind: 'contract',
      address: 'ST_DEPLOYER',
      name: 'pyth-lazer-decoder-v1',
    });
  });

  test('uses the configured fixed fee', async () => {
    await newSubmitter({ txFeeMicroStx: 3_000 }).submit(EVM);
    assert.equal(lastCallOpts().fee, 3_000n);
  });

  test('lets the SDK estimate the fee when none is configured', async () => {
    await newSubmitter().submit(EVM);
    assert.equal(lastCallOpts().fee, undefined, 'no explicit fee passed');
  });

  test('replaces an unmined tx at the same nonce with a higher fee (RBF)', async () => {
    confirmedNonce = 5n;
    const submitter = newSubmitter({ txFeeMicroStx: 1_000 });

    await submitter.submit(EVM); // fresh @ nonce 5, fee 1000
    await submitter.submit(EVM); // chain hasn't advanced -> replace

    assert.equal(makeContractCallFn.mock.callCount(), 2);
    const opts = lastCallOpts();
    assert.equal(opts.nonce, 5n, 'same nonce');
    assert.equal(opts.fee, 1_250n, '+25%');
  });

  test('submits fresh at the new nonce once the previous tx mines', async () => {
    confirmedNonce = 5n;
    const submitter = newSubmitter({ txFeeMicroStx: 1_000 });

    await submitter.submit(EVM); // @ nonce 5
    confirmedNonce = 6n; // mined
    await submitter.submit(EVM);

    const opts = lastCallOpts();
    assert.equal(opts.nonce, 6n);
    assert.equal(opts.fee, 1_000n, 'fresh fee, not bumped');
  });

  test('escalates the fee across successive replacements', async () => {
    confirmedNonce = 5n; // never advances
    const submitter = newSubmitter({ txFeeMicroStx: 1_000 });

    await submitter.submit(EVM); // 1000
    await submitter.submit(EVM); // 1250
    await submitter.submit(EVM); // 1250 + 312 = 1562

    assert.equal(lastCallOpts().fee, 1_562n);
  });

  test('stops replacing once the fee ceiling is reached', async () => {
    confirmedNonce = 5n;
    const submitter = newSubmitter({ txFeeMicroStx: 1_000, maxFeeMicroStx: 1_200 });

    const first = await submitter.submit(EVM); // 1000
    const second = await submitter.submit(EVM); // clamped to ceiling 1200
    const third = await submitter.submit(EVM); // cannot exceed ceiling -> refuse

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(lastCallOpts().fee, 1_200n);

    assert.equal(third.ok, false);
    assert.match(third.error ?? '', /ceiling/);
    assert.equal(makeContractCallFn.mock.callCount(), 2, 'no third tx built');
  });

  test('drops pending on a nonce rejection so the next attempt re-reads the chain', async () => {
    confirmedNonce = 5n;
    const submitter = newSubmitter({ txFeeMicroStx: 1_000 });

    await submitter.submit(EVM); // ok @ nonce 5

    broadcastResult = { error: 'bad', reason: 'BadNonce', txid: '' };
    const rejected = await submitter.submit(EVM); // replace attempt -> rejected
    assert.equal(rejected.ok, false);

    // Pending was dropped; submit fresh at whatever the chain now reports.
    broadcastResult = { txid: '0xfresh' };
    confirmedNonce = 9n;
    await submitter.submit(EVM);
    assert.equal(lastCallOpts().nonce, 9n, 'fresh nonce, not a replacement of nonce 5');
  });

  test('keeps pending on a non-nonce rejection (still replaces from the last good fee)', async () => {
    confirmedNonce = 5n;
    const submitter = newSubmitter({ txFeeMicroStx: 1_000 });

    await submitter.submit(EVM); // ok @ nonce 5, fee 1000

    broadcastResult = { error: 'poor', reason: 'NotEnoughFunds', txid: '' };
    await submitter.submit(EVM); // replace built at 1250, but broadcast rejected

    broadcastResult = { txid: '0xok' };
    await submitter.submit(EVM); // pending still {5, 1000} -> bumps to 1250 again

    const opts = lastCallOpts();
    assert.equal(opts.nonce, 5n, 'still replacing the same pending nonce');
    assert.equal(opts.fee, 1_250n, 'bumped from the last successful fee, not the rejected one');
  });

  test('returns ok:false and resets pending when building throws', async () => {
    confirmedNonce = 5n;
    const submitter = newSubmitter({ txFeeMicroStx: 1_000 });

    makeContractCallFn.mock.mockImplementationOnce(async () => {
      throw new Error('node unreachable');
    });
    const result = await submitter.submit(EVM);

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /node unreachable/);
  });
});
