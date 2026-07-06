import { createCoreRpcClient, type CoreRpcClient } from '@stacks/rpc-client';
import { Cl, ClarityType, cvToHex, hexToCV } from '@stacks/transactions';
import BigNumber from 'bignumber.js';
import * as metrics from '../metrics.ts';

/** A price record as stored on-chain in the `pyth-lazer-storage` contract. */
export interface OnChainPrice {
  /** Price mantissa (scaled by `exponent`). */
  price: BigNumber;
  /** Publish time in microseconds (the storage monotonic-guard key). */
  publishTime: bigint;
}

/** Result of a read-only call as returned by the Stacks node. */
interface ReadOnlyResult {
  okay: boolean;
  result?: string;
  cause?: string;
}

/**
 * Reads the Pyth Lazer contract state over the Stacks core RPC. Used to seed the relayer's
 * deviation baselines from the actual on-chain values so we don't redundantly re-push prices that
 * are already current.
 */
export class ContractSymbolPriceReader {
  private readonly client: CoreRpcClient;
  /** Deployer principal for the Pyth Lazer contracts (also used as the sender for read-only calls). */
  private readonly sender: string;

  constructor(options: { sender: string; rpcBaseUrl: string }) {
    this.client = createCoreRpcClient({
      baseUrl: options.rpcBaseUrl,
    });
    this.sender = options.sender;
  }

  /**
   * Reads `.pyth-lazer-storage.get-price` for a feed.
   * @param feedId - Pyth Lazer numeric feed id.
   * @returns The stored record, or `null` if the feed has never been published (the call returned
   *   an `(err ...)`).
   */
  async getPrice(feedId: number): Promise<OnChainPrice | null> {
    const cv = await this.callReadOnly('pyth-lazer-storage', 'get-price', [Cl.uint(feedId)]);
    // `get-price` returns `(ok { price, publish-time, ... })` or `(err ...)`.
    if (cv.type !== ClarityType.ResponseOk) return null;
    const record = cv.value;
    if (record.type !== ClarityType.Tuple) return null;
    const price = record.value['price'];
    const publishTime = record.value['publish-time'];
    if (price?.type !== ClarityType.Int || publishTime?.type !== ClarityType.UInt) {
      return null;
    }
    return { price: new BigNumber(price.value), publishTime: BigInt(publishTime.value) };
  }

  /**
   * Reads governance's stale-price threshold (seconds). The heartbeat interval
   * must stay below this or feeds can read as stale between pushes.
   */
  async getStalePriceThresholdSeconds(): Promise<bigint | null> {
    const cv = await this.callReadOnly('pyth-lazer-governance', 'get-stale-price-threshold', []);
    return cv.type === ClarityType.UInt ? BigInt(cv.value) : null;
  }

  private async callReadOnly(
    contractName: string,
    functionName: string,
    args: Parameters<typeof cvToHex>[0][]
  ) {
    const method = functionName.replace(/-/g, '_'); // bounded label: get_price | get_stale_price_threshold
    const endTimer = metrics.rpcRequestDuration.startTimer({ method });
    try {
      const res = (await this.client.request(
        'POST',
        '/v2/contracts/call-read/{deployer_address}/{contract_name}/{function_name}',
        {
          params: {
            path: {
              deployer_address: this.sender,
              contract_name: contractName,
              function_name: functionName,
            },
          },
          body: { sender: this.sender, arguments: args.map(cvToHex) },
        }
      )) as ReadOnlyResult;

      if (!res.okay || !res.result) {
        throw new Error(
          `read-only call ${contractName}.${functionName} failed: ${res.cause ?? 'unknown'}`
        );
      }
      metrics.rpcRequests.inc({ method, result: 'success' });
      return hexToCV(res.result);
    } catch (error) {
      metrics.rpcRequests.inc({ method, result: 'error' });
      throw error;
    } finally {
      endTimer();
    }
  }
}
