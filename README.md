# Pyth Lazer relayer

> **Status: proof of concept.** The pipeline described below is implemented and
> unit-tested. On-chain submission has been exercised on testnet. It is not yet
> production-hardened — see [Known limitations](#known-limitations).

## Role

A relayer is the off-chain half of the oracle. It holds a Pyth Lazer
subscription, receives signed `evm`-format price updates over Lazer's WebSocket
stream, decides which are worth relaying, and submits them to
[`pyth-lazer-oracle-v1.verify-and-update-price-feeds`](../clarity/contracts/pyth-lazer-oracle-v1.clar)
on Stacks. On-chain security comes from the **signature, not the caller**, so
submission is permissionless — anyone can relay a valid update (self-relay).

## Architecture

The service is a Node 24 / ESM / TypeScript app. The pipeline is four units
under `src/relayer/`, wired together in [`src/index.ts`](src/index.ts) via
constructor injection (units read config from their options, not the environment):

| Unit | Responsibility |
|---|---|
| [`PythSymbolMonitor`](src/relayer/pyth-symbol-monitor.ts) | Holds the Lazer WebSocket subscription; emits each update as `(evm, parsed)`. |
| [`PriceUpdatePlanner`](src/relayer/price-update-planner.ts) | The relay heuristic — decides *whether* each update should be submitted. |
| [`PriceUpdateTransactionSubmitter`](src/relayer/price-update-transaction-submitter.ts) | Builds, signs, and broadcasts the contract call. |
| [`ContractSymbolPriceReader`](src/relayer/contract-symbol-price-reader.ts) | Read-only contract reads (on-chain price baselines, stale-price threshold). |

A small [Fastify API](src/api) exposes `POST /relayer/v1/price-update` (also available at
`POST /relayer/price-update`) with body `{ symbol }`, where `symbol` is a `Crypto.`-prefixed
pair such as `Crypto.BTC/USD`, to add a pair to the monitored set and force an immediate on-demand push. Configuration is
centralized and validated in
[`src/env.ts`](src/env.ts).

```
Lazer WS ──(evm, parsed)──▶ PriceUpdatePlanner ──submit(evm)──▶ Submitter ──▶ pyth-lazer-oracle-v1
             monitor              │  reads baselines                          (verify-and-update-price-feeds)
                                  ▼
                        ContractSymbolPriceReader
```

### Monitor — one subscription, ≤16 feeds

All monitored symbols ride in **one** signed Lazer message, because the contract
decodes a single signed buffer into a `(list 16 ...)` of feeds. So the monitor:

- keeps the monitored set in a 16-entry LRU cache; adding a pair (or LRU
  eviction) refreshes the single subscription so it always reflects the current
  set under one subscription id;
- requests only the properties the contract stores (`price`, `exponent`,
  `publisher-count` are required; `confidence`/`bestBid`/`bestAsk`/`ema*` ride
  along as optional);
- **validates** new symbols against the Lazer catalog (`getSymbols`, cached and
  periodically refreshed); unknown symbols are rejected (the API returns `400`).
  As a backstop it subscribes with `ignoreInvalidFeedIds` and evicts any feeds
  Lazer reports as invalid;
- **debounces** subscription refreshes so a burst of `requestPriceUpdate` calls
  collapses into a single unsubscribe/resubscribe.

### Planner — the relay heuristic

Because one message carries all feeds, the planner decides at message
granularity: if *any* feed is due, the whole signed payload is submitted in one
transaction (updating all feeds). Triggers:

- **price deviation** — a feed moves beyond a bps threshold vs. its on-chain baseline;
- **heartbeat** — force a push at least every N ms; must be **shorter than**
  governance's stale-price threshold (checked at startup);
- **on-demand** — an external request forces the next push.

A **cadence floor** (no point submitting faster than Stacks block production,
~5s Nakamoto) and a **publish-time freshness guard** suppress redundant/no-op
submissions, and only one submission is in flight at a time. Baselines are keyed
by numeric feed id (straight from the parsed payload — no symbol resolution
needed) and seeded lazily from the on-chain value via the reader.

### Submitter — one in-flight tx, replace-by-fee

The submitter keeps a single transaction in flight. Each call reads the
confirmed nonce and either submits fresh (previous tx mined, or none) or, if the
previous tx is still unmined, **replaces** it at the same nonce with a bumped fee
(Stacks mempool replace-by-fee) — escalating across replacements up to an
optional ceiling.

## Configuration

All via environment variables (see [`src/env.ts`](src/env.ts) for defaults):

| Variable | Purpose |
|---|---|
| `NETWORK` | `mainnet` \| `testnet`. |
| `API_HOST` / `API_PORT` | Relayer API server bind address. |
| `PROMETHEUS_HOST` / `PROMETHEUS_PORT` | Bind address for the metrics server (see [Metrics](#metrics)). |
| `STACKS_NODE_RPC_SCHEME` / `STACKS_NODE_RPC_HOST` / `STACKS_NODE_RPC_PORT` | Stacks node RPC endpoint (`http` or `https`). |
| `PYTH_API_KEY` | Pyth Lazer subscription token. |
| `PYTH_LAZER_CHANNEL` | `real_time` \| `fixed_rate_50ms` \| `fixed_rate_200ms` \| `fixed_rate_1000ms`. |
| `PYTH_CLIENT_NUM_CONNECTIONS` | Redundant WebSocket connections. |
| `PYTH_CATALOG_REFRESH_MS` | How often to refresh the symbol catalog. |
| `PYTH_REFRESH_DEBOUNCE_MS` | Debounce window for subscription refreshes. |
| `PYTH_DEPLOYER_STACKS_ADDRESS` | Principal that deployed the `pyth-lazer-*` contracts. |
| `TX_SUBMITTER_PRIVATE_KEY` | Key that signs and pays for update txs. |
| `TX_SUBMITTER_FEE_USTX` | Optional fixed tx fee; otherwise estimated. |
| `TX_SUBMITTER_FEE_BUMP_PERCENT` | Fee increase per replace-by-fee round. |
| `TX_SUBMITTER_MAX_FEE_USTX` | Optional ceiling on the escalating replacement fee. |
| `PRICE_UPDATE_DEVIATION_BPS` | Deviation trigger threshold (bps). |
| `PRICE_UPDATE_HEARTBEAT_MS` | Heartbeat trigger interval. |
| `PRICE_UPDATE_MIN_SUBMIT_INTERVAL_MS` | Cadence floor between submissions. |

## Metrics

Prometheus metrics are exposed on a **separate server** at `GET /metrics`, bound to
`PROMETHEUS_HOST:PROMETHEUS_PORT` (default `0.0.0.0:9153`) — kept off the public API
port so it can stay internal to the network/pod. Exposition includes:

- custom `relayer_*` metrics for each pipeline stage (see [`src/metrics.ts`](src/metrics.ts));
- default `prom-client` process metrics (event-loop lag, heap, GC);
- per-route HTTP metrics for the relayer API.

Key signals to alert on: `relayer_last_submit_timestamp_seconds` (staleness — the core
oracle SLI; alert as it approaches governance's stale-price threshold),
`relayer_wallet_balance_microstx` (the account can't submit once it's dry),
`relayer_pyth_connection_up` / `relayer_pyth_last_message_timestamp_seconds` (stream
liveness), and `relayer_tx_rejections_total` (broadcast failures).

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm run dev         # node --watch src/index.ts
npm start           # node dist/index.js

# per-unit test suites (node:test via tsx)
npm run test:pyth-symbol-monitor
npm run test:price-update-planner
npm run test:price-update-transaction-submitter
npm run test:contract-symbol-price-reader
```

## Known limitations

- **Broadcast-ok ≠ mined.** Baselines advance on successful broadcast, not on
  confirmation — a mined-but-aborted tx (e.g. a monotonic-guard skip) can briefly
  drift the baseline until the next push corrects it. No confirmation tracking yet.
- Single signing key from env; no key-management / secret-store integration.

## Open questions (gating a production build)

Commercial/legal answers needed from Pyth before operating a production relayer:

1. Is **on-chain publication** of Lazer data to a public ledger permitted under
   the subscription tier?
2. Is **off-chain message proxying** to third parties allowed, or must each
   consumer subscribe directly?
3. What **tier / pricing** applies to an infrastructure relayer?

See [`../clarity/PLAN.md`](../clarity/PLAN.md) for the contract side.
