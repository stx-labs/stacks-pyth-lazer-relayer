import { logger } from '@stacks/api-toolkit';
import type { ParsedPayload } from '@pythnetwork/pyth-lazer-sdk';
import type { ContractSymbolPriceReader } from './contract-symbol-price-reader.ts';
import type { OnChainPrice } from './contract-symbol-price-reader.ts';
import type { PriceUpdateTransactionSubmitter } from './price-update-transaction-submitter.js';
import BigNumber from 'bignumber.js';
import * as metrics from '../metrics.ts';

/** Why a submission was triggered (for logging / metrics). */
type SubmitReason = 'on-demand' | 'heartbeat' | 'deviation';

/**
 * `undefined` — baseline not yet resolved from chain (skip deviation for it);
 * `null` — resolved, feed has never been published (push to establish);
 * value — last on-chain price/publish-time we deviate against.
 */
type Baseline = OnChainPrice | null;

/**
 * Decides which Pyth Lazer updates to relay on-chain. Because every monitored feed rides in one
 * signed message, the decision is made per message. If any feed is "due" — by deviation, heartbeat,
 * or an on-demand request — the whole signed payload is submitted in a single transaction, updating
 * all feeds.
 *
 * Deviation baselines are keyed by numeric feed id (taken straight from the parsed payload, so no
 * symbol resolution is needed) and seeded lazily from the on-chain value the first time a feed is
 * seen.
 */
export class PriceUpdatePlanner {
  private readonly reader: ContractSymbolPriceReader;
  private readonly submitter: PriceUpdateTransactionSubmitter;

  private readonly heartbeatMs: number;
  private readonly minSubmitIntervalMs: number;
  private readonly deviationBps: BigNumber;

  /** Last on-chain price per feed id (see {@link Baseline}). */
  private readonly baselines = new Map<number, Baseline>();
  /** Feed ids with an in-flight baseline read, to avoid duplicate RPC calls. */
  private readonly resolving = new Set<number>();

  /** Wall-clock ms of the last submission (heartbeat + cadence reference). */
  private lastSubmitAtMs = Date.now();
  /** Publish-time (µs) of the last submitted message; guards against re-pushing. */
  private lastSubmittedTimestampUs = 0n;
  /** A submission is being broadcast / awaited. */
  private inFlight = false;
  /** An on-demand push has been requested. */
  private pendingForce = false;

  constructor(opts: {
    reader: ContractSymbolPriceReader;
    submitter: PriceUpdateTransactionSubmitter;
    heartbeatMs: number;
    minSubmitIntervalMs: number;
    deviationBps: number;
  }) {
    this.reader = opts.reader;
    this.submitter = opts.submitter;
    this.heartbeatMs = opts.heartbeatMs;
    this.minSubmitIntervalMs = opts.minSubmitIntervalMs;
    this.deviationBps = new BigNumber(opts.deviationBps);
  }

  /** Best-effort sanity check: warn if heartbeat won't keep feeds fresh. */
  async validateHeartbeat(): Promise<void> {
    try {
      const thresholdSeconds = await this.reader.getStalePriceThresholdSeconds();
      if (thresholdSeconds !== null && BigInt(this.heartbeatMs) >= thresholdSeconds * 1000n) {
        logger.warn(
          { heartbeatMs: this.heartbeatMs, staleThresholdSeconds: Number(thresholdSeconds) },
          `${this.constructor.name} heartbeat is not shorter than the stale-price threshold; feeds may read as stale between pushes`
        );
      }
    } catch (error) {
      logger.warn(error, `${this.constructor.name} could not read stale-price threshold`);
    }
  }

  /**
   * Marks the next eligible message to be pushed regardless of deviation.
   */
  requestImmediateUpdate(): void {
    this.pendingForce = true;
  }

  /**
   * Entry point: evaluate one streamed update and submit it if any feed is due.
   * @param evm - The EVM payload.
   * @param parsed - The parsed payload.
   */
  handlePriceMonitorPayload(evm: Buffer, parsed: ParsedPayload): void {
    metrics.updatesEvaluated.inc();
    const timestampUs = BigInt(parsed.timestampUs);
    metrics.feedPublishLag.observe(Math.max(0, (Date.now() - Number(timestampUs / 1000n)) / 1000));

    this.seedBaselines(parsed);

    if (this.inFlight) {
      metrics.submissionsSuppressed.inc({ reason: 'in_flight' });
      return;
    }

    const now = Date.now();
    if (now - this.lastSubmitAtMs < this.minSubmitIntervalMs) {
      metrics.submissionsSuppressed.inc({ reason: 'cadence_floor' }); // faster than block time
      return;
    }

    if (timestampUs <= this.lastSubmittedTimestampUs) {
      metrics.submissionsSuppressed.inc({ reason: 'not_newer' }); // on-chain no-op
      return;
    }

    const reason = this.shouldSubmit(now, parsed);
    if (!reason) {
      metrics.submissionsSuppressed.inc({ reason: 'no_trigger' });
      return;
    }

    metrics.submissionsTriggered.inc({ reason: reason.replace('-', '_') });
    this.submitPriceUpdate(evm, parsed, timestampUs, reason);
  }

  /**
   * Determine whether (and why) this message should be submitted.
   * @param now - The current time.
   * @param parsed - The parsed payload.
   * @returns The reason why the message should be submitted, or `null` if it should not be
   * submitted.
   */
  private shouldSubmit(now: number, parsed: ParsedPayload): SubmitReason | null {
    if (this.pendingForce) return 'on-demand';
    if (now - this.lastSubmitAtMs >= this.heartbeatMs) return 'heartbeat';

    const deviatesEnough = (
      price: BigNumber,
      baseline: BigNumber,
      deviationBps: BigNumber
    ): boolean => {
      if (baseline.eq(0)) return !price.eq(0);
      const diff = price.gt(baseline) ? price.minus(baseline) : baseline.minus(price);
      const magnitude = baseline.lt(0) ? baseline.negated() : baseline;
      return diff.multipliedBy(10_000).gte(deviationBps.multipliedBy(magnitude));
    };

    for (const feed of parsed.priceFeeds) {
      if (feed.price == null) continue;
      const baseline = this.baselines.get(feed.priceFeedId);
      if (baseline === undefined) continue; // still resolving; can't judge deviation
      if (baseline === null) return 'deviation'; // never published — establish it
      if (deviatesEnough(new BigNumber(feed.price), baseline.price, this.deviationBps))
        return 'deviation';
    }
    return null;
  }

  /**
   * Submits a signed update to the on-chain prices update function.
   * @param evm - The EVM payload.
   * @param parsed - The parsed payload.
   * @param timestampUs - The timestamp in microseconds.
   * @param reason - The reason why the message should be submitted.
   */
  private submitPriceUpdate(
    evm: Buffer,
    parsed: ParsedPayload,
    timestampUs: bigint,
    reason: SubmitReason
  ): void {
    this.inFlight = true;
    logger.info(
      { reason, feeds: parsed.priceFeeds.length, timestampUs: parsed.timestampUs },
      `${this.constructor.name} submitting signed update`
    );

    this.submitter
      .submit(evm)
      .then(result => {
        if (!result.ok) {
          logger.error(
            { error: result.error },
            `${this.constructor.name} submission failed: ${result.error}`
          );
          return;
        }
        // Advance baselines to the prices we just pushed.
        this.lastSubmitAtMs = Date.now();
        this.lastSubmittedTimestampUs = timestampUs;
        this.pendingForce = false;
        metrics.lastSubmitTimestamp.set(this.lastSubmitAtMs / 1000);
        for (const feed of parsed.priceFeeds) {
          if (feed.price != null) {
            this.baselines.set(feed.priceFeedId, {
              price: new BigNumber(feed.price),
              publishTime: timestampUs,
            });
          }
        }
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(error, `${this.constructor.name} submission interrupted: ${message}`);
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  /**
   * Kick off on-chain baseline reads for any newly-seen feed ids.
   * @param parsed - The parsed payload.
   */
  private seedBaselines(parsed: ParsedPayload): void {
    for (const feed of parsed.priceFeeds) {
      const feedId = feed.priceFeedId;
      if (this.baselines.has(feedId) || this.resolving.has(feedId)) continue;
      this.resolving.add(feedId);
      this.reader
        .getPrice(feedId)
        .then(baseline => {
          // Don't clobber a baseline a submission may have set in the meantime.
          if (!this.baselines.has(feedId)) this.baselines.set(feedId, baseline);
        })
        .catch(error => {
          // Leave unresolved so the next message retries; heartbeat still covers us.
          logger.warn(
            { error, feedId },
            `${this.constructor.name} failed to read on-chain baseline`
          );
        })
        .finally(() => {
          this.resolving.delete(feedId);
        });
    }
  }
}
