import Fastify, { type FastifyPluginAsync } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import FastifyCors from '@fastify/cors';
import fastifyMetrics from 'fastify-metrics';
import type { Server } from 'http';
import { PINO_LOGGER_CONFIG } from '@stacks/api-toolkit';
import { PairsRoutes } from './routes/pairs.js';
import type { PythSymbolMonitor } from '../relayer/pyth-symbol-monitor.ts';
import type { PriceUpdatePlanner } from '../relayer/price-update-planner.ts';
import * as promClient from 'prom-client';

/** Configuration for the API service. */
export interface ApiConfig {
  pythSymbolMonitor: PythSymbolMonitor;
  planner: PriceUpdatePlanner;
}

export const Api: FastifyPluginAsync<ApiConfig, Server, TypeBoxTypeProvider> = async (
  fastify,
  config
) => {
  // Pass only app config down — `config` here also carries the register `prefix`,
  // and forwarding it would double-prefix the routes (already applied to this context).
  await fastify.register(PairsRoutes, {
    pythSymbolMonitor: config.pythSymbolMonitor,
    planner: config.planner,
  });
};

export async function buildApiServer(config: ApiConfig) {
  const fastify = Fastify({
    trustProxy: true,
    logger: PINO_LOGGER_CONFIG,
  }).withTypeProvider<TypeBoxTypeProvider>();

  await fastify.register(FastifyCors);
  await fastify.register(fastifyMetrics.default, {
    endpoint: null,
    promClient: promClient,
  });
  await fastify.register(Api, { ...config, prefix: '/relayer/v1' });
  await fastify.register(Api, { ...config, prefix: '/relayer' });

  return fastify;
}
