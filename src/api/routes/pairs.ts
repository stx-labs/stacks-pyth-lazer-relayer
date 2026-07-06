import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Server } from 'http';
import type { FastifyPluginCallback } from 'fastify';
import type { ApiConfig } from '../init.js';
import {
  PriceUpdateBodySchema,
  PriceUpdateResponseSchema,
  ErrorResponseSchema,
} from '../schemas.js';

export const PairsRoutes: FastifyPluginCallback<ApiConfig, Server, TypeBoxTypeProvider> = (
  fastify,
  config,
  done
) => {
  fastify.post(
    '/price-update',
    {
      schema: {
        body: PriceUpdateBodySchema,
        response: {
          200: PriceUpdateResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { pythSymbolMonitor } = config;

      // The schema guarantees exactly one of `symbol` / `feed_id`; resolve a feed
      // id to its symbol.
      let symbol: string;
      if (request.body.symbol !== undefined) {
        symbol = request.body.symbol;
      } else if (request.body.feed_id !== undefined) {
        const resolved = pythSymbolMonitor.symbolForFeedId(request.body.feed_id);
        if (!resolved) {
          return reply.status(400).send({
            error: 'unknown_feed_id',
            message: `Unknown or unsupported Pyth Lazer feed id: ${request.body.feed_id}`,
          });
        }
        symbol = resolved;
      } else {
        // Unreachable: `minProperties` requires one to be present.
        return reply.status(400).send({
          error: 'invalid_request',
          message: 'Provide exactly one of `symbol` or `feed_id`',
        });
      }

      // Add to the monitored set (validated against the Lazer catalog).
      const accepted = pythSymbolMonitor.requestPriceUpdate(symbol);
      if (!accepted) {
        return reply.status(400).send({
          error: 'unknown_symbol',
          message: `Unknown or unsupported Pyth Lazer symbol: ${symbol}`,
        });
      }

      // On-demand trigger: force the next eligible update to be relayed on-chain,
      // regardless of the deviation threshold.
      config.planner.requestImmediateUpdate();

      return reply.status(200).send({ message: 'Price update requested', symbol });
    }
  );
  done();
};
