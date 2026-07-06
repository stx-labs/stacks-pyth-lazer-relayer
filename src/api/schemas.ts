import { Type } from '@sinclair/typebox';

/**
 * A Pyth Lazer crypto symbol, e.g. `Crypto.BTC/USD`. We only relay crypto pairs, so the symbol must
 * carry the `Crypto.` asset-class prefix — the schema rejects anything else with a 400 before it
 * reaches the monitor.
 */
export const CryptoSymbolSchema = Type.String({
  pattern: '^Crypto\\.[A-Za-z0-9]+/[A-Za-z0-9]+$',
  description: 'Pyth Lazer crypto symbol, e.g. "Crypto.BTC/USD"',
  examples: ['Crypto.BTC/USD'],
});

/** A Pyth Lazer numeric feed id, resolved to a crypto symbol via the catalog. */
export const FeedIdSchema = Type.Integer({
  minimum: 0,
  description: 'Pyth Lazer numeric feed id',
  examples: [1],
});

/**
 * Request body: a caller supplies **either** a `Crypto.` symbol **or** a numeric
 * `feed_id` (resolved to a symbol server-side). Exactly one shape must match.
 */
export const PriceUpdateBodySchema = Type.Object(
  {
    symbol: Type.Optional(CryptoSymbolSchema),
    feed_id: Type.Optional(FeedIdSchema),
  },
  {
    // Exactly one of `symbol` / `feed_id`. Declaring both on one object (rather than a union of
    // single-key objects) keeps Fastify's ajv `removeAdditional` from silently stripping the
    // "other" field; `min/maxProperties` then enforce that precisely one is supplied.
    additionalProperties: false,
    minProperties: 1,
    maxProperties: 1,
  }
);

export const PriceUpdateResponseSchema = Type.Object({
  message: Type.String(),
  symbol: CryptoSymbolSchema,
});

/** Shape covering both handler errors and Fastify's schema-validation errors. */
export const ErrorResponseSchema = Type.Object({
  error: Type.String(),
  message: Type.Optional(Type.String()),
});
