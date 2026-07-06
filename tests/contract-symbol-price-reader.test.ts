import { beforeEach, describe, mock, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Cl, cvToHex } from '@stacks/transactions';

/** Test-tunable response the mocked core RPC client returns from `request`. */
let response: { okay: boolean; result?: string; cause?: string } = { okay: true };
const requestFn = mock.fn(async () => response);
const createCoreRpcClientFn = mock.fn(() => ({ request: requestFn }));

// Mock only the network layer; `@stacks/transactions` stays real so the reader's
// actual Clarity (de)serialization is exercised against genuine hex fixtures.
mock.module('@stacks/rpc-client', {
  namedExports: { createCoreRpcClient: createCoreRpcClientFn },
});

const { ContractSymbolPriceReader } = await import(
  '../src/relayer/contract-symbol-price-reader.ts'
);

const OPTS = { sender: 'ST_DEPLOYER', rpcBaseUrl: 'http://node' };

/** Wrap a Clarity value as the node would return it from a read-only call. */
function ok(cv: Parameters<typeof cvToHex>[0]) {
  return { okay: true, result: cvToHex(cv) };
}

describe('ContractSymbolPriceReader', () => {
  beforeEach(() => {
    response = { okay: true };
    requestFn.mock.resetCalls();
    createCoreRpcClientFn.mock.resetCalls();
  });

  test('builds the RPC client against the configured base URL', () => {
    new ContractSymbolPriceReader(OPTS);
    assert.deepEqual(createCoreRpcClientFn.mock.calls[0]?.arguments[0], { baseUrl: 'http://node' });
  });

  test('getPrice parses an (ok record) into price + publishTime', async () => {
    response = ok(
      Cl.ok(
        Cl.tuple({
          price: Cl.int(12_345),
          'publish-time': Cl.uint(1_700_000_000_000_000n),
        })
      )
    );

    const result = await new ContractSymbolPriceReader(OPTS).getPrice(7);

    assert.ok(result);
    assert.equal(result.price.toString(), '12345');
    assert.equal(result.publishTime, 1_700_000_000_000_000n);

    // It calls storage.get-price with the feed id as a uint argument.
    const [method, path, init] = requestFn.mock.calls[0]!.arguments as [string, string, any];
    assert.equal(method, 'POST');
    assert.equal(path, '/v2/contracts/call-read/{deployer_address}/{contract_name}/{function_name}');
    assert.equal(init.params.path.contract_name, 'pyth-lazer-storage');
    assert.equal(init.params.path.function_name, 'get-price');
    assert.equal(init.params.path.deployer_address, 'ST_DEPLOYER');
    assert.deepEqual(init.body.arguments, [cvToHex(Cl.uint(7))]);
  });

  test('getPrice returns null when the feed was never published (err)', async () => {
    response = ok(Cl.error(Cl.uint(3003))); // ERR_PRICE_FEED_NOT_FOUND
    const result = await new ContractSymbolPriceReader(OPTS).getPrice(7);
    assert.equal(result, null);
  });

  test('getPrice returns null when the record fields are missing or mistyped', async () => {
    // price is a uint here, not the expected int.
    response = ok(Cl.ok(Cl.tuple({ price: Cl.uint(1), 'publish-time': Cl.uint(2) })));
    const result = await new ContractSymbolPriceReader(OPTS).getPrice(7);
    assert.equal(result, null);
  });

  test('getPrice rejects when the node call fails', async () => {
    response = { okay: false, cause: 'Runtime error' };
    await assert.rejects(
      () => new ContractSymbolPriceReader(OPTS).getPrice(7),
      /get-price failed: Runtime error/
    );
  });

  test('getStalePriceThresholdSeconds returns the uint value', async () => {
    response = ok(Cl.uint(3_600));
    const result = await new ContractSymbolPriceReader(OPTS).getStalePriceThresholdSeconds();
    assert.equal(result, 3_600n);
  });

  test('getStalePriceThresholdSeconds returns null on an unexpected type', async () => {
    response = ok(Cl.ok(Cl.uint(3_600))); // a response, not a bare uint
    const result = await new ContractSymbolPriceReader(OPTS).getStalePriceThresholdSeconds();
    assert.equal(result, null);
  });
});
