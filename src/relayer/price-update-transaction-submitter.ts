import { logger } from '@stacks/api-toolkit';
import { createCoreRpcClient, type CoreRpcClient } from '@stacks/rpc-client';
import {
  Cl,
  broadcastTransaction,
  getAddressFromPrivateKey,
  makeContractCall,
  type TxBroadcastResult,
} from '@stacks/transactions';
import * as metrics from '../metrics.ts';

/** Contracts (all under the same deployer) and the write entry point. */
const ORACLE_CONTRACT_NAME = 'pyth-lazer-oracle-v1';
const DECODER_CONTRACT_NAME = 'pyth-lazer-decoder-v1';
const UPDATE_FUNCTION_NAME = 'verify-and-update-price-feeds';

/**
 * Broadcast rejection reasons that mean our locally-tracked nonce is stale; on
 * these we drop it and refetch from chain before the next attempt.
 */
const NONCE_REJECTION_REASONS = new Set<string>([
  'BadNonce',
  'ConflictingNonceInMempool',
  'TooMuchChaining',
]);

/** Outcome of attempting to submit a signed update on-chain. */
export interface SubmitResult {
  /** Whether the update was accepted (broadcast) successfully. */
  ok: boolean;
  /** Transaction id, when broadcast succeeded. */
  txId?: string;
  /** Failure detail, when `ok` is false. */
  error?: string;
}

/** A transaction we have broadcast but not yet confirmed mined. */
interface PendingTx {
  /** Nonce the tx was signed with. */
  nonce: bigint;
  /** Fee (microSTX) the tx was broadcast with; the floor for any replacement. */
  fee: bigint;
}

/**
 * Builds, signs, and broadcasts the `verify-and-update-price-feeds` contract call with the signed
 * `evm` payload and the blessed decoder.
 *
 * Only one tx is ever in flight: each call reads the chain's confirmed nonce and either submits a
 * fresh tx (previous one mined, or none) or — if a previous tx is still unmined — *replaces* it by
 * rebroadcasting at the same nonce with a higher fee (Stacks mempool replace-by-fee). This keeps the
 * freshest price moving toward the chain and avoids paying to mine a now-stale update.
 */
export class PriceUpdateTransactionSubmitter {
  private readonly senderKey;
  private readonly network: 'mainnet' | 'testnet';
  private readonly deployer: string;
  private readonly rpcBaseUrl: string;
  private readonly senderAddress: string;
  private readonly txFeeMicroStx?: number;
  private readonly feeBumpPercent: bigint;
  private readonly maxFeeMicroStx?: bigint;
  /** Core RPC client, used to read the sender's confirmed nonce. */
  private readonly rpc: CoreRpcClient;
  /** The last broadcast tx, tracked until a later read shows it confirmed. */
  private pending?: PendingTx;

  constructor(options: {
    senderKey: string;
    network: 'mainnet' | 'testnet';
    deployer: string;
    rpcBaseUrl: string;
    txFeeMicroStx?: number;
    feeBumpPercent: number;
    maxFeeMicroStx?: number;
  }) {
    this.senderKey = options.senderKey;
    this.network = options.network;
    this.deployer = options.deployer;
    this.rpcBaseUrl = options.rpcBaseUrl;
    this.txFeeMicroStx = options.txFeeMicroStx;
    this.feeBumpPercent = BigInt(options.feeBumpPercent);
    this.maxFeeMicroStx =
      options.maxFeeMicroStx != null ? BigInt(options.maxFeeMicroStx) : undefined;
    this.senderAddress = getAddressFromPrivateKey(this.senderKey, this.network);
    this.rpc = createCoreRpcClient({ baseUrl: this.rpcBaseUrl });
  }

  async submit(evm: Buffer): Promise<SubmitResult> {
    let kind: 'fresh' | 'replace' = 'fresh';
    const endTimer = metrics.txBuildDuration.startTimer();
    try {
      const target = await this.resolveTarget();
      if (!target) {
        metrics.txFeeCeilingHits.inc();
        return { ok: false, error: 'fee ceiling reached; cannot replace pending tx' };
      }
      kind = target.replacing ? 'replace' : 'fresh';

      const transaction = await makeContractCall({
        contractAddress: this.deployer,
        contractName: ORACLE_CONTRACT_NAME,
        functionName: UPDATE_FUNCTION_NAME,
        functionArgs: [Cl.buffer(evm), Cl.contractPrincipal(this.deployer, DECODER_CONTRACT_NAME)],
        senderKey: this.senderKey,
        network: this.network,
        client: { baseUrl: this.rpcBaseUrl },
        nonce: target.nonce,
        // A replacement must set an explicit (higher) fee; a fresh tx uses the
        // configured fixed fee or lets the SDK estimate it.
        ...(target.fee != null ? { fee: target.fee } : {}),
        // The oracle transfers the governance fee from tx-sender, so post
        // conditions can't be enumerated up front — allow them.
        postConditionMode: 'allow',
      });

      // The actual fee the tx carries (estimated or fixed) — the floor for any
      // future replacement of this nonce.
      const fee = transaction.auth.spendingCondition.fee;
      const result = await broadcastTransaction({
        transaction,
        network: this.network,
        client: { baseUrl: this.rpcBaseUrl },
      });
      return this.handleBroadcastResult(result, target.nonce, fee, target.replacing);
    } catch (error) {
      // Build/network failure: drop pending so the next attempt re-reads the chain.
      this.pending = undefined;
      metrics.txSubmissions.inc({ kind, result: 'error' });
      const message = error instanceof Error ? error.message : String(error);
      logger.error(error, `${this.constructor.name} failed to build/broadcast update: ${message}`);
      return { ok: false, error: message };
    } finally {
      endTimer();
    }
  }

  private handleBroadcastResult(
    result: TxBroadcastResult,
    nonce: bigint,
    fee: bigint,
    replacing: boolean
  ): SubmitResult {
    const txId = result.txid.startsWith('0x') ? result.txid : `0x${result.txid}`;
    const kind = replacing ? 'replace' : 'fresh';
    metrics.txFee.observe(Number(fee));

    if (!('error' in result)) {
      this.pending = { nonce, fee };
      metrics.txSubmissions.inc({ kind, result: 'broadcast' });
      if (replacing) metrics.txReplacements.inc();
      logger.info(
        { txId, nonce: Number(nonce), fee: Number(fee), replacing },
        replacing
          ? `${this.constructor.name} replaced unmined update (RBF)`
          : `${this.constructor.name} broadcast price update`
      );
      return { ok: true, txId };
    }

    // A nonce rejection means our assumption about the pending tx is wrong; drop
    // it so the next attempt re-reads the chain from scratch.
    if (NONCE_REJECTION_REASONS.has(result.reason)) {
      this.pending = undefined;
    }
    metrics.txSubmissions.inc({ kind, result: 'rejected' });
    metrics.txRejections.inc({ reason: result.reason });
    logger.error(
      { reason: result.reason, error: result.error, txId },
      `${this.constructor.name} broadcast rejected: ${result.reason}`
    );
    return { ok: false, error: `${result.reason}: ${result.error}` };
  }

  /**
   * Decide what nonce/fee the next submission should use: replace the pending tx if it is still
   * unmined, otherwise submit fresh at the chain's confirmed nonce.
   * @returns The target, or `null` if a replacement is needed but the fee ceiling has been reached.
   */
  private async resolveTarget(): Promise<{
    nonce: bigint;
    fee?: bigint;
    replacing: boolean;
  } | null> {
    const confirmedNonce = await this.fetchConfirmedNonce();

    // Pending tx still unmined (the chain hasn't advanced past its nonce): replace it at the same
    // nonce with a higher fee.
    if (this.pending && confirmedNonce <= this.pending.nonce) {
      const fee = this.bumpFee(this.pending.fee);
      if (fee === null) return null;
      return { nonce: this.pending.nonce, fee, replacing: true };
    }
    // Otherwise the pending tx (if any) has mined: submit fresh at the confirmed nonce, letting the
    // fee be fixed-or-estimated.
    return {
      nonce: confirmedNonce,
      fee: this.txFeeMicroStx != null ? BigInt(this.txFeeMicroStx) : undefined,
      replacing: false,
    };
  }

  /**
   * Reads the sender's confirmed account nonce from the core node. We need the
   * *confirmed* value (not a mempool-aware "possible next nonce") so we can detect
   * that our own unmined tx is still pending and replace it.
   */
  private async fetchConfirmedNonce(): Promise<bigint> {
    const endTimer = metrics.rpcRequestDuration.startTimer({ method: 'account' });
    try {
      const account = await this.rpc.request('GET', '/v2/accounts/{principal}', {
        params: { path: { principal: this.senderAddress }, query: { proof: 0 } },
      });
      metrics.rpcRequests.inc({ method: 'account', result: 'success' });
      // Balance rides along on the same response — track it to alert before the
      // account can no longer pay fees. Isolated so a parse hiccup can't fail the read.
      try {
        if (account.balance) metrics.walletBalance.set(Number(BigInt(account.balance)));
      } catch {
        /* ignore balance parse errors */
      }
      return BigInt(account.nonce);
    } catch (error) {
      metrics.rpcRequests.inc({ method: 'account', result: 'error' });
      throw error;
    } finally {
      endTimer();
    }
  }

  /**
   * Raise a fee by the configured percent for a replacement, clamped to the optional ceiling.
   * @param fee - The fee of the tx being replaced.
   * @returns The (strictly higher) replacement fee, or `null` if it cannot exceed the previous fee
   *   without breaching the ceiling.
   */
  private bumpFee(fee: bigint): bigint | null {
    const raised = fee + (fee * this.feeBumpPercent) / 100n;
    const bumped = raised > fee ? raised : fee + 1n; // guarantee strictly higher
    if (this.maxFeeMicroStx == null) return bumped;
    if (bumped <= this.maxFeeMicroStx) return bumped;
    // Use the ceiling itself if it still beats the previous fee, else give up.
    return this.maxFeeMicroStx > fee ? this.maxFeeMicroStx : null;
  }
}
