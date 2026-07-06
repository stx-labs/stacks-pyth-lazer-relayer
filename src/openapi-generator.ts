import Fastify from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Api } from '../src/api/init.js';
import FastifySwagger from '@fastify/swagger';
import { writeFileSync } from 'fs';
import { OpenApiSchemaOptions } from '../src/api/schemas.js';
import type { PythSymbolMonitor } from './relayer/pyth-symbol-monitor.ts';
import type { PriceUpdatePlanner } from './relayer/price-update-planner.ts';

/**
 * Generates `openapi.yaml` based on current Swagger definitions.
 */
async function generateOpenApiFiles() {
  const fastify = Fastify({
    trustProxy: true,
    logger: true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  await fastify.register(FastifySwagger, OpenApiSchemaOptions);
  await fastify.register(Api, {
    pythSymbolMonitor: undefined as unknown as PythSymbolMonitor,
    planner: undefined as unknown as PriceUpdatePlanner,
    prefix: '/pyth-lazer-relayer/v1',
  });
  await fastify.ready();

  writeFileSync('./openapi.yaml', fastify.swagger({ yaml: true }));
  await fastify.close();
}

void generateOpenApiFiles();
