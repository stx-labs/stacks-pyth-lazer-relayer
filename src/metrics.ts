import { Counter, Gauge, Histogram } from 'prom-client';

/**
 * Prometheus metrics for the relayer. Each metric auto-registers with prom-client's
 * default registry, which is exposed by the dedicated metrics server at `GET /metrics`
 * (alongside default process metrics and per-route HTTP metrics collected by fastify-metrics).
 *
 * Cardinality is kept bounded: `symbol` is capped at 16 and `reason`/`method`/`result`
 * are fixed enums. High-cardinality detail (tx ids, raw errors) belongs in logs.
 */

const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];

// ── Pyth stream / monitor ────────────────────────────────────────────────────

/** 1 while at least one Lazer connection is up, 0 when all are down. */
export const pythConnectionUp = new Gauge({
  name: 'relayer_pyth_connection_up',
  help: 'Whether at least one Pyth Lazer connection is up (1) or all are down (0)',
});

export const pythMessagesReceived = new Counter({
  name: 'relayer_pyth_messages_received_total',
  help: 'Messages received on the Pyth Lazer subscription',
  labelNames: ['type'], // 'binary' | 'json'
});

/** Unix time (seconds) of the last message; alert on `time() - metric > threshold`. */
export const pythLastMessageTimestamp = new Gauge({
  name: 'relayer_pyth_last_message_timestamp_seconds',
  help: 'Unix timestamp of the last message received from Pyth Lazer',
});

export const symbolsSubscribed = new Gauge({
  name: 'relayer_symbols_subscribed',
  help: 'Number of symbols currently in the subscription (0-16)',
});

export const subscriptionRefreshes = new Counter({
  name: 'relayer_subscription_refreshes_total',
  help: 'Times the single Lazer subscription was (re)established',
});

export const symbolsRejected = new Counter({
  name: 'relayer_symbols_rejected_total',
  help: 'Symbols rejected or dropped',
  labelNames: ['reason'], // 'unknown_symbol' | 'lazer_ignored'
});

export const catalogLoads = new Counter({
  name: 'relayer_catalog_load_total',
  help: 'Pyth symbol-catalog load attempts',
  labelNames: ['result'], // 'success' | 'error'
});

export const catalogSymbols = new Gauge({
  name: 'relayer_catalog_symbols',
  help: 'Number of symbols in the loaded Pyth catalog',
});

// ── Planner (relay heuristic) ────────────────────────────────────────────────

export const updatesEvaluated = new Counter({
  name: 'relayer_updates_evaluated_total',
  help: 'Streamed updates the planner evaluated',
});

export const submissionsTriggered = new Counter({
  name: 'relayer_submissions_triggered_total',
  help: 'Submissions triggered, by reason',
  labelNames: ['reason'], // 'deviation' | 'heartbeat' | 'on_demand'
});

export const submissionsSuppressed = new Counter({
  name: 'relayer_submissions_suppressed_total',
  help: 'Updates evaluated but not submitted, by reason',
  labelNames: ['reason'], // 'in_flight' | 'cadence_floor' | 'not_newer' | 'no_trigger'
});

/** Unix time (seconds) of the last successful submission; the core staleness SLI. */
export const lastSubmitTimestamp = new Gauge({
  name: 'relayer_last_submit_timestamp_seconds',
  help: 'Unix timestamp of the last successful on-chain submission',
});

export const feedPublishLag = new Histogram({
  name: 'relayer_feed_publish_lag_seconds',
  help: 'Age of a received update: now minus its Lazer publish-time',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

// ── Submitter (tx broadcast + replace-by-fee) ────────────────────────────────

export const txSubmissions = new Counter({
  name: 'relayer_tx_submissions_total',
  help: 'Transaction submissions by kind and result',
  labelNames: ['kind', 'result'], // kind: 'fresh'|'replace'; result: 'broadcast'|'rejected'|'error'
});

export const txRejections = new Counter({
  name: 'relayer_tx_rejections_total',
  help: 'Broadcast rejections, by node-reported reason',
  labelNames: ['reason'],
});

export const txReplacements = new Counter({
  name: 'relayer_tx_replacements_total',
  help: 'Replace-by-fee rebroadcasts of an unmined transaction',
});

export const txFee = new Histogram({
  name: 'relayer_tx_fee_microstx',
  help: 'Fee (microSTX) carried by broadcast transactions',
  buckets: [1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000],
});

export const txFeeCeilingHits = new Counter({
  name: 'relayer_tx_fee_ceiling_hits_total',
  help: 'Replacements refused because the fee ceiling was reached',
});

export const txBuildDuration = new Histogram({
  name: 'relayer_tx_build_duration_seconds',
  help: 'Time to build, sign, and broadcast a transaction',
  buckets: DURATION_BUCKETS,
});

export const walletBalance = new Gauge({
  name: 'relayer_wallet_balance_microstx',
  help: 'STX balance (microSTX) of the submitter account',
});

// ── Reader / RPC (dependency health) ─────────────────────────────────────────

export const rpcRequests = new Counter({
  name: 'relayer_rpc_requests_total',
  help: 'Stacks node RPC requests by method and result',
  labelNames: ['method', 'result'], // result: 'success' | 'error'
});

export const rpcRequestDuration = new Histogram({
  name: 'relayer_rpc_request_duration_seconds',
  help: 'Stacks node RPC request duration',
  labelNames: ['method'],
  buckets: DURATION_BUCKETS,
});
