import { after, afterEach, before, describe, mock, test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { FastifyInstance } from 'fastify';
import { buildApiServer, type ApiConfig } from '../src/api/init.ts';

const URL = '/relayer/v1/price-update';

// Fakes for the dependencies the route touches.
const requestPriceUpdate = mock.fn((_symbol: string): boolean => true);
const symbolForFeedId = mock.fn((_feedId: number): string | undefined => undefined);
const requestImmediateUpdate = mock.fn();

const config = {
  pythSymbolMonitor: { requestPriceUpdate, symbolForFeedId },
  planner: { requestImmediateUpdate },
} as unknown as ApiConfig;

let app: FastifyInstance;

describe('POST /price-update', () => {
  // Build the server once — buildApiServer registers fastify-metrics, which
  // collects default metrics on the shared prom-client registry and would throw
  // if registered per-test.
  before(async () => {
    app = await buildApiServer(config);
  });
  after(async () => {
    await app.close();
  });

  afterEach(() => {
    requestPriceUpdate.mock.resetCalls();
    requestPriceUpdate.mock.mockImplementation(() => true);
    symbolForFeedId.mock.resetCalls();
    symbolForFeedId.mock.mockImplementation(() => undefined);
    requestImmediateUpdate.mock.resetCalls();
  });

  test('accepts a known crypto symbol and forces an on-demand push', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: { symbol: 'Crypto.BTC/USD' } });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { message: 'Price update requested', symbol: 'Crypto.BTC/USD' });
    assert.deepEqual(requestPriceUpdate.mock.calls[0]?.arguments, ['Crypto.BTC/USD']);
    assert.equal(requestImmediateUpdate.mock.callCount(), 1);
  });

  test('rejects a symbol the monitor does not recognize', async () => {
    requestPriceUpdate.mock.mockImplementation(() => false);

    const res = await app.inject({ method: 'POST', url: URL, payload: { symbol: 'Crypto.NOPE/USD' } });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'unknown_symbol');
    assert.equal(requestImmediateUpdate.mock.callCount(), 0, 'no push for an unknown symbol');
  });

  test('rejects a non-crypto symbol at the schema layer', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: { symbol: 'Equity.AAPL/USD' } });

    assert.equal(res.statusCode, 400);
    assert.equal(requestPriceUpdate.mock.callCount(), 0, 'never reaches the handler');
  });

  test('rejects a symbol missing the Crypto. prefix', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: { symbol: 'BTC/USD' } });

    assert.equal(res.statusCode, 400);
    assert.equal(requestPriceUpdate.mock.callCount(), 0);
  });

  test('rejects a malformed crypto symbol (no pair)', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: { symbol: 'Crypto.BTCUSD' } });

    assert.equal(res.statusCode, 400);
    assert.equal(requestPriceUpdate.mock.callCount(), 0);
  });

  test('rejects a body with neither symbol nor feed_id', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: {} });

    assert.equal(res.statusCode, 400);
    assert.equal(requestPriceUpdate.mock.callCount(), 0);
  });

  test('resolves a feed_id to its symbol and forces an on-demand push', async () => {
    symbolForFeedId.mock.mockImplementation(() => 'Crypto.BTC/USD');

    const res = await app.inject({ method: 'POST', url: URL, payload: { feed_id: 1 } });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { message: 'Price update requested', symbol: 'Crypto.BTC/USD' });
    assert.deepEqual(symbolForFeedId.mock.calls[0]?.arguments, [1]);
    assert.deepEqual(requestPriceUpdate.mock.calls[0]?.arguments, ['Crypto.BTC/USD']);
    assert.equal(requestImmediateUpdate.mock.callCount(), 1);
  });

  test('rejects a feed_id the catalog cannot resolve', async () => {
    symbolForFeedId.mock.mockImplementation(() => undefined);

    const res = await app.inject({ method: 'POST', url: URL, payload: { feed_id: 99999 } });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'unknown_feed_id');
    assert.equal(requestPriceUpdate.mock.callCount(), 0, 'never reaches the monitor');
    assert.equal(requestImmediateUpdate.mock.callCount(), 0);
  });

  test('rejects a non-integer feed_id at the schema layer', async () => {
    const res = await app.inject({ method: 'POST', url: URL, payload: { feed_id: 'abc' } });

    assert.equal(res.statusCode, 400);
    assert.equal(symbolForFeedId.mock.callCount(), 0, 'never reaches the handler');
  });

  test('rejects a body with both symbol and feed_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      payload: { symbol: 'Crypto.BTC/USD', feed_id: 1 },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(requestPriceUpdate.mock.callCount(), 0, 'never reaches the handler');
    assert.equal(symbolForFeedId.mock.callCount(), 0);
  });
});
