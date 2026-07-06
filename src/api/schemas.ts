import { Type } from '@sinclair/typebox';
import { isProdEnv, logger, SERVER_VERSION } from '@stacks/api-toolkit';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { SwaggerOptions } from '@fastify/swagger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const openApiVersion = (() => {
  if (isProdEnv) return SERVER_VERSION.tag;
  try {
    const packageJsonPath = resolve(__dirname, '../../package.json');
    return (JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string }).version;
  } catch (error) {
    logger.error(error, 'Error reading version from package.json');
    return SERVER_VERSION.tag;
  }
})();

export const OpenApiSchemaOptions: SwaggerOptions = {
  openapi: {
    info: {
      title: 'Stacks Pyth Lazer Relayer API',
      description:
        'API reference for the Stacks Pyth Lazer Relayer API. Service that relays price updates from the Pyth Network to the Stacks blockchain.',
      version: openApiVersion,
    },
    externalDocs: {
      url: 'https://github.com/stx-labs/stacks-pyth-lazer-relayer',
      description: 'Source Repository',
    },
    servers: [
      {
        url: 'https://api.hiro.so/',
        description: 'mainnet',
      },
      {
        url: 'https://api.testnet.hiro.so/',
        description: 'testnet',
      },
    ],
    tags: [
      {
        name: 'Price Updates',
        description: 'Price update endpoints',
      },
    ],
  },
};

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
