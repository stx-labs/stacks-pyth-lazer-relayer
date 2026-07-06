import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { strict as assert } from 'node:assert';

/**
 * Fake Pyth Lazer client capturing the calls the monitor makes against it. A
 * fresh one is produced by every `PythLazerClient.create`, so each `start()`
 * gets isolated call counts.
 */
interface FakeClient {
  subscribe: ReturnType<typeof mock.fn>;
  unsubscribe: ReturnType<typeof mock.fn>;
  addMessageListener: ReturnType<typeof mock.fn>;
  addAllConnectionsDownListener: ReturnType<typeof mock.fn>;
  addConnectionRestoredListener: ReturnType<typeof mock.fn>;
  getSymbols: ReturnType<typeof mock.fn>;
  shutdown: ReturnType<typeof mock.fn>;
  /** The message handler the monitor registered via `addMessageListener`. */
  listener?: (event: unknown) => void;
}

/** Symbols the fake catalog reports as valid; tests may extend it. */
let catalogSymbols: string[] = [];

function makeFakeClient(): FakeClient {
  const client: FakeClient = {
    subscribe: mock.fn(),
    unsubscribe: mock.fn(),
    addMessageListener: mock.fn((handler: (event: unknown) => void) => {
      client.listener = handler;
    }),
    addAllConnectionsDownListener: mock.fn(),
    addConnectionRestoredListener: mock.fn(),
    // The monitor loads this at start() to validate symbols and build the
    // feed-id map; `symbol` mirrors `name`, and `pyth_lazer_id` is the 1-based index.
    getSymbols: mock.fn(async () =>
      catalogSymbols.map((name, i) => ({ name, symbol: name, pyth_lazer_id: i + 1 }))
    ),
    shutdown: mock.fn(),
  };
  return client;
}

/** The client returned by the most recent `PythLazerClient.create`. */
let lastClient: FakeClient | undefined;
const createFn = mock.fn(async () => {
  lastClient = makeFakeClient();
  return lastClient;
});

// Replace the SDK before importing the monitor so its `PythLazerClient` binding
// resolves to our fake. Requires `--experimental-test-module-mocks`.
mock.module('@pythnetwork/pyth-lazer-sdk', {
  namedExports: { PythLazerClient: { create: createFn } },
});

const { PythSymbolMonitor } = await import('../src/relayer/pyth-symbol-monitor.ts');

const DEFAULT_SYMBOLS = ['Crypto.BTC/USD', 'Crypto.STX/USD', 'Crypto.USDC/USD'];
const SUBSCRIPTION_ID = 1;
/** Comfortably past the monitor's debounce window (250ms). */
const PAST_DEBOUNCE_MS = 1_000;

const OPTS = {
  channel: 'fixed_rate_200ms',
  apiKey: 'test-key',
  numConnections: 2,
  catalogRefreshMs: 3_600_000,
  refreshDebounceMs: 250,
};

/** Build, start, and return a monitor along with its fake client + payload spy. */
async function startMonitor(opts: Partial<typeof OPTS> = {}) {
  const onPayload = mock.fn();
  const monitor = new PythSymbolMonitor({ ...OPTS, ...opts });
  await monitor.start(onPayload);
  // `lastClient` is set by the mocked `create` during `start()`.
  return { monitor, onPayload, client: lastClient! };
}

/** The argument of the most recent `subscribe` call. */
function lastSubscribeArg(client: FakeClient): any {
  const { calls } = client.subscribe.mock;
  return calls[calls.length - 1]?.arguments[0];
}

function assertSameSymbols(actual: string[], expected: string[]) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

describe('PythSymbolMonitor', () => {
  beforeEach(() => {
    lastClient = undefined;
    createFn.mock.resetCalls();
    // Broad catalog so the symbols the tests subscribe to validate as known.
    catalogSymbols = [
      ...DEFAULT_SYMBOLS,
      'Crypto.ETH/USD',
      ...Array.from({ length: 20 }, (_, i) => `Crypto.SYM${i}/USD`),
    ];
    // Fake setTimeout so the debounced refresh can be driven deterministically.
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    // Reset spies/timers but keep the module mock in place for the next test.
    mock.timers.reset();
  });

  test('subscribes to the default symbols on start', async () => {
    const { client } = await startMonitor();

    assert.equal(createFn.mock.callCount(), 1);
    assert.equal(client.subscribe.mock.callCount(), 1);

    const request = lastSubscribeArg(client);
    assert.equal(request.type, 'subscribe');
    assert.equal(request.subscriptionId, SUBSCRIPTION_ID);
    assertSameSymbols(request.symbols, DEFAULT_SYMBOLS);
    // The exact property set is a tuning knob, but the fields the contract
    // requires to store a feed must always be requested.
    for (const required of ['price', 'exponent', 'publisherCount']) {
      assert.ok(request.properties.includes(required), `requests ${required}`);
    }
    assert.deepEqual(request.formats, ['evm']);
    assert.equal(request.deliveryFormat, 'binary');
    assert.equal(request.parsed, true);
    assert.equal(request.channel, 'fixed_rate@200ms');
    assert.equal(request.ignoreInvalidFeedIds, true, 'backstop against one bad symbol');
  });

  test('registers connection listeners on start', async () => {
    const { client } = await startMonitor();
    assert.equal(client.addMessageListener.mock.callCount(), 1);
    assert.equal(client.addAllConnectionsDownListener.mock.callCount(), 1);
    assert.equal(client.addConnectionRestoredListener.mock.callCount(), 1);
  });

  test('throws on an invalid channel', () => {
    assert.throws(
      () => new PythSymbolMonitor({ ...OPTS, channel: 'every_block' }),
      /Invalid Pyth Lazer channel/
    );
  });

  test('start is idempotent', async () => {
    const monitor = new PythSymbolMonitor(OPTS);
    await monitor.start();
    await monitor.start();
    assert.equal(createFn.mock.callCount(), 1);
  });

  test('requestPriceUpdate adds a new symbol and re-subscribes with the full set', async () => {
    const { monitor, client } = await startMonitor();

    assert.equal(monitor.requestPriceUpdate('Crypto.ETH/USD'), true);
    // Refresh is debounced — nothing happens until the window elapses.
    assert.equal(client.subscribe.mock.callCount(), 1);
    mock.timers.tick(PAST_DEBOUNCE_MS);

    // Re-subscription tears down the old subscription first, then re-subscribes.
    assert.equal(client.unsubscribe.mock.callCount(), 1);
    assert.deepEqual(client.unsubscribe.mock.calls[0]?.arguments, [SUBSCRIPTION_ID]);
    assert.equal(client.subscribe.mock.callCount(), 2);
    assertSameSymbols(lastSubscribeArg(client).symbols, [...DEFAULT_SYMBOLS, 'Crypto.ETH/USD']);
  });

  test('requestPriceUpdate is a no-op for an already-monitored symbol', async () => {
    const { monitor, client } = await startMonitor();

    assert.equal(monitor.requestPriceUpdate('Crypto.BTC/USD'), true); // already a default

    assert.equal(client.subscribe.mock.callCount(), 1, 'no re-subscribe');
    assert.equal(client.unsubscribe.mock.callCount(), 0);
  });

  test('requestPriceUpdate rejects a symbol not in the catalog', async () => {
    const { monitor, client } = await startMonitor();

    const accepted = monitor.requestPriceUpdate('Crypto.NOPE/USD');

    assert.equal(accepted, false);
    assert.equal(client.subscribe.mock.callCount(), 1, 'subscription untouched');
    assert.ok(!lastSubscribeArg(client).symbols.includes('Crypto.NOPE/USD'));
  });

  test('symbolForFeedId resolves a known crypto feed id to its symbol', async () => {
    const { monitor } = await startMonitor();
    // Fake catalog assigns 1-based ids; 'Crypto.BTC/USD' is the first entry.
    assert.equal(monitor.symbolForFeedId(1), 'Crypto.BTC/USD');
  });

  test('symbolForFeedId returns undefined for an unknown feed id', async () => {
    const { monitor } = await startMonitor();
    assert.equal(monitor.symbolForFeedId(99999), undefined);
  });

  test('symbolForFeedId excludes non-crypto feeds', async () => {
    catalogSymbols = ['Crypto.BTC/USD', 'Equity.AAPL/USD']; // ids 1 and 2
    const { monitor } = await startMonitor();
    assert.equal(monitor.symbolForFeedId(1), 'Crypto.BTC/USD');
    assert.equal(monitor.symbolForFeedId(2), undefined, 'equity feed is not resolvable');
  });

  test('accepts any symbol when the catalog fails to load (fails open)', async () => {
    const client = makeFakeClient();
    client.getSymbols.mock.mockImplementation(async () => {
      throw new Error('catalog unavailable');
    });
    createFn.mock.mockImplementationOnce(async () => {
      lastClient = client;
      return client;
    });

    const monitor = new PythSymbolMonitor(OPTS);
    await monitor.start();

    // Validation disabled -> the relayer is not blocked by a missing catalog.
    assert.equal(monitor.requestPriceUpdate('Crypto.ANYTHING/USD'), true);
  });

  test('evicts feeds Lazer reports as invalid via the subscription ack', async () => {
    const { monitor, client } = await startMonitor();

    client.listener?.({
      type: 'json',
      value: {
        type: 'subscribedWithInvalidFeedIdsIgnored',
        subscriptionId: SUBSCRIPTION_ID,
        subscribedFeedIds: [],
        ignoredInvalidFeedIds: {
          unknownSymbols: ['Crypto.STX/USD'],
          unknownIds: [],
          unsupportedChannels: [],
          unstable: [],
        },
      },
    });

    // Trigger a re-subscribe and confirm the evicted symbol is gone from the set.
    monitor.requestPriceUpdate('Crypto.ETH/USD');
    mock.timers.tick(PAST_DEBOUNCE_MS);
    assert.ok(!lastSubscribeArg(client).symbols.includes('Crypto.STX/USD'));
  });

  test('caps the monitored set at 16 symbols, evicting least-recently-used', async () => {
    const { monitor, client } = await startMonitor();

    const added = Array.from({ length: 16 }, (_, i) => `Crypto.SYM${i}/USD`);
    for (const symbol of added) monitor.requestPriceUpdate(symbol);

    // The whole burst debounces into a single refresh.
    mock.timers.tick(PAST_DEBOUNCE_MS);
    assert.equal(client.subscribe.mock.callCount(), 2, 'one refresh for the whole burst');

    const request = lastSubscribeArg(client);
    assert.equal(request.symbols.length, 16);
    assert.ok(request.symbols.includes('Crypto.SYM15/USD'), 'keeps the most recent');
    assert.ok(!request.symbols.includes('Crypto.BTC/USD'), 'evicts the oldest default');
  });

  test('forwards binary updates (evm + parsed) to the payload handler', async () => {
    const { client, onPayload, monitor } = await startMonitor();

    const evm = Buffer.from([0x01, 0x02]);
    const parsed = { timestampUs: '12345', priceFeeds: [{ priceFeedId: 1, price: '100' }] };
    client.listener?.({ type: 'binary', value: { subscriptionId: SUBSCRIPTION_ID, evm, parsed } });

    assert.equal(onPayload.mock.callCount(), 1);
    assert.deepEqual(onPayload.mock.calls[0]?.arguments, [evm, parsed]);
    assert.equal(monitor.lastPayload, parsed);
  });

  test('ignores messages for a different subscription id and unsubscribes from it', async () => {
    const { client, onPayload } = await startMonitor();

    const parsed = { timestampUs: '1', priceFeeds: [] };
    client.listener?.({ type: 'binary', value: { subscriptionId: 999, evm: Buffer.from([1]), parsed } });

    assert.equal(onPayload.mock.callCount(), 0);
    assert.equal(client.unsubscribe.mock.callCount(), 1);
    assert.deepEqual(client.unsubscribe.mock.calls[0]?.arguments, [999]);
  });

  test('ignores non-binary (json) messages', async () => {
    const { client, onPayload } = await startMonitor();
    client.listener?.({ type: 'json', value: { type: 'subscribed', subscriptionId: SUBSCRIPTION_ID } });
    assert.equal(onPayload.mock.callCount(), 0);
  });

  test('does not forward when the evm payload is missing', async () => {
    const { client, onPayload, monitor } = await startMonitor();

    const parsed = { timestampUs: '7', priceFeeds: [{ priceFeedId: 1, price: '100' }] };
    client.listener?.({ type: 'binary', value: { subscriptionId: SUBSCRIPTION_ID, parsed } });

    assert.equal(onPayload.mock.callCount(), 0);
    assert.equal(monitor.lastPayload, parsed, 'still records the latest parsed payload');
  });

  test('stop shuts the client down and allows a later restart', async () => {
    const { monitor, client } = await startMonitor();

    await monitor.stop();
    assert.equal(client.shutdown.mock.callCount(), 1);

    await monitor.start();
    assert.equal(createFn.mock.callCount(), 2, 'reconnects on restart');
  });

  test('stop is safe to call when never started', async () => {
    const monitor = new PythSymbolMonitor(OPTS);
    await assert.doesNotReject(() => monitor.stop());
  });
});
