import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import envSchema from 'env-schema';

const schema = Type.Object({
  /** Specifies which Stacks network this API is indexing */
  NETWORK: Type.Enum({ mainnet: 'mainnet', testnet: 'testnet' }, { default: 'mainnet' }),

  /** Hostname of the relayer API server */
  API_HOST: Type.String({ default: '0.0.0.0' }),
  /** Port in which to serve the API */
  API_PORT: Type.Number({ default: 3000, minimum: 0, maximum: 65535 }),

  /** Hostname of the Prometheus server */
  PROMETHEUS_HOST: Type.String({ default: '0.0.0.0' }),
  /** Port in which to serve the Prometheus metrics */
  PROMETHEUS_PORT: Type.Number({ default: 9153, minimum: 0, maximum: 65535 }),

  /** Scheme for the Stacks node RPC endpoint. Use `https` for public/TLS nodes. */
  STACKS_NODE_RPC_SCHEME: Type.Enum({ http: 'http', https: 'https' }, { default: 'http' }),
  /** Stacks node RPC host */
  STACKS_NODE_RPC_HOST: Type.String(),
  /** Stacks node RPC port */
  STACKS_NODE_RPC_PORT: Type.Number({ minimum: 0, maximum: 65535 }),

  /** Pyth API key */
  PYTH_API_KEY: Type.String(),
  /** Pyth Lazer channel to subscribe to. Defaults to `fixed_rate_200ms`. */
  PYTH_LAZER_CHANNEL: Type.Enum(
    {
      real_time: 'real_time',
      fixed_rate_50ms: 'fixed_rate_50ms',
      fixed_rate_200ms: 'fixed_rate_200ms',
      fixed_rate_1000ms: 'fixed_rate_1000ms',
    },
    { default: 'fixed_rate_200ms' }
  ),
  /** Number of redundant websocket connections in the pool. Defaults to 4. */
  PYTH_CLIENT_NUM_CONNECTIONS: Type.Integer({ default: 4, minimum: 1 }),
  /** How often (ms) to refresh the Pyth symbol catalog used to validate pairs. Defaults to 6h. */
  PYTH_CATALOG_REFRESH_MS: Type.Integer({ default: 6 * 60 * 60 * 1000, minimum: 1000 }),
  /** Debounce window (ms) for coalescing bursts of subscription changes. Defaults to 250. */
  PYTH_REFRESH_DEBOUNCE_MS: Type.Integer({ default: 250, minimum: 0 }),
  /**
   * Principal that deployed the Pyth Lazer contracts. The oracle, decoder, storage, and governance
   * contract ids are derived from it (`<deployer>.pyth-lazer-oracle-v1`, etc.).
   */
  PYTH_DEPLOYER_STACKS_ADDRESS: Type.String(),

  /** Secret key (hex) of the relayer account that signs and pays for update txs. */
  TX_SUBMITTER_PRIVATE_KEY: Type.String(),
  /** Optional fixed tx fee (microSTX) for update txs. If unset, the fee is estimated. */
  TX_SUBMITTER_FEE_USTX: Type.Optional(Type.Integer({ minimum: 0 })),
  /**
   * When a newer update is due but our previous tx is still unmined, replace it
   * (same nonce, higher fee). This is the percent the fee is raised each round.
   * Defaults to 25.
   */
  TX_SUBMITTER_FEE_BUMP_PERCENT: Type.Integer({ default: 25, minimum: 1 }),
  /** Optional ceiling (microSTX) on the fee when escalating replacements. */
  TX_SUBMITTER_MAX_FEE_USTX: Type.Optional(Type.Integer({ minimum: 0 })),

  /**
   * Push a feed when its price moves at least this many basis points from the value last written
   * on-chain (100 bps = 1%). Defaults to 50 (0.5%).
   */
  PRICE_UPDATE_DEVIATION_BPS: Type.Integer({ default: 50, minimum: 1 }),
  /**
   * Force a push at least this often (ms) even if prices are flat. Must be shorter than
   * governance's stale-price threshold. Defaults to 30s.
   */
  PRICE_UPDATE_HEARTBEAT_MS: Type.Integer({ default: 30_000, minimum: 1 }),
  /**
   * Minimum spacing between submissions (ms). No point submitting faster than Stacks block
   * production (~5s, Nakamoto). Defaults to 5s.
   */
  PRICE_UPDATE_MIN_SUBMIT_INTERVAL_MS: Type.Integer({ default: 5_000, minimum: 0 }),
});
type Env = Static<typeof schema>;

export const ENV = envSchema<Env>({
  schema: schema,
  dotenv: true,
});
