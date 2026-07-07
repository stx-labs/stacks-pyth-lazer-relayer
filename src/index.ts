import { logger, PINO_LOGGER_CONFIG, registerShutdownConfig, timeout } from '@stacks/api-toolkit';
import { createCoreRpcClient } from '@stacks/rpc-client';
import { buildApiServer } from './api/init.js';
import { ENV } from './env.js';
import { PythSymbolMonitor } from './relayer/pyth-symbol-monitor.ts';
import { PriceUpdatePlanner } from './relayer/price-update-planner.ts';
import { PriceUpdateTransactionSubmitter } from './relayer/price-update-transaction-submitter.ts';
import { ContractSymbolPriceReader } from './relayer/contract-symbol-price-reader.ts';
import type { ApiConfig } from './api/init.js';
import * as promClient from 'prom-client';
import Fastify from 'fastify';

/**
 * Initializes background services.
 * @param config - API configuration.
 */
async function initBackgroundServices(config: ApiConfig) {
  logger.info('Initializing background services...');

  await config.planner.validateHeartbeat();

  registerShutdownConfig({
    name: 'Pyth Price Monitor',
    forceKillable: true,
    handler: async () => {
      await config.pythSymbolMonitor.stop();
    },
  });
  await config.pythSymbolMonitor.start((evm, parsed) =>
    config.planner.handlePriceMonitorPayload(evm, parsed)
  );
}

/**
 * Initializes API service.
 * @param config - API configuration.
 */
async function initApiService(config: ApiConfig) {
  logger.info('Initializing API service...');
  const apiServer = await buildApiServer(config);
  registerShutdownConfig({
    name: 'API Server',
    forceKillable: true,
    handler: async () => {
      await apiServer.close();
    },
  });
  await apiServer.listen({ host: ENV.API_HOST, port: ENV.API_PORT });

  const promServer = Fastify({
    trustProxy: true,
    logger: PINO_LOGGER_CONFIG,
  });
  promServer.route({
    url: '/metrics',
    method: 'GET',
    logLevel: 'info',
    handler: async (_, reply) => {
      const metrics: string = await promClient.register.metrics();
      await reply.type(promClient.register.contentType).send(metrics);
    },
  });
  registerShutdownConfig({
    name: 'Prometheus Server',
    forceKillable: true,
    handler: async () => {
      await promServer.close();
    },
  });
  await promServer.listen({ host: ENV.PROMETHEUS_HOST, port: ENV.PROMETHEUS_PORT });
}

/**
 * Validates the Stacks node RPC is reachable by probing `/v2/info` and blocking until it succeeds.
 * @param rpcBaseUrl - Base URL of the Stacks node RPC endpoint.
 */
async function waitForStacksNode(rpcBaseUrl: string) {
  const client = createCoreRpcClient({ baseUrl: rpcBaseUrl });
  logger.info(`Connecting to Stacks node at ${rpcBaseUrl}...`);
  const stacksNodeProbeRetryMs = 3_000;
  for (let attempt = 1; ; attempt++) {
    try {
      const info = await client.request('GET', '/v2/info');
      logger.info(
        `Connected to Stacks node at ${rpcBaseUrl} (network id: ${info.network_id}, stacks tip height: ${info.stacks_tip_height})`
      );
      return;
    } catch (error) {
      logger.warn(
        error,
        `Stacks node at ${rpcBaseUrl} not reachable (attempt ${attempt}), retrying in ${stacksNodeProbeRetryMs}ms...`
      );
      await timeout(stacksNodeProbeRetryMs);
    }
  }
}

/**
 * Initializes the application.
 */
async function initApp() {
  const nodeRpcBaseUrl = `${ENV.STACKS_NODE_RPC_SCHEME}://${ENV.STACKS_NODE_RPC_HOST}:${ENV.STACKS_NODE_RPC_PORT}`;
  await waitForStacksNode(nodeRpcBaseUrl);

  const reader = new ContractSymbolPriceReader({
    sender: ENV.PYTH_DEPLOYER_STACKS_ADDRESS,
    rpcBaseUrl: nodeRpcBaseUrl,
  });

  const submitter = new PriceUpdateTransactionSubmitter({
    senderKey: ENV.TX_SUBMITTER_PRIVATE_KEY,
    network: ENV.NETWORK,
    deployer: ENV.PYTH_DEPLOYER_STACKS_ADDRESS,
    txFeeMicroStx: ENV.TX_SUBMITTER_FEE_USTX,
    feeBumpPercent: ENV.TX_SUBMITTER_FEE_BUMP_PERCENT,
    maxFeeMicroStx: ENV.TX_SUBMITTER_MAX_FEE_USTX,
    rpcBaseUrl: nodeRpcBaseUrl,
  });

  const planner = new PriceUpdatePlanner({
    reader,
    submitter,
    heartbeatMs: ENV.PRICE_UPDATE_HEARTBEAT_MS,
    minSubmitIntervalMs: ENV.PRICE_UPDATE_MIN_SUBMIT_INTERVAL_MS,
    deviationBps: ENV.PRICE_UPDATE_DEVIATION_BPS,
  });

  const pythSymbolMonitor = new PythSymbolMonitor({
    channel: ENV.PYTH_LAZER_CHANNEL,
    apiKey: ENV.PYTH_API_KEY,
    numConnections: ENV.PYTH_CLIENT_NUM_CONNECTIONS,
    catalogRefreshMs: ENV.PYTH_CATALOG_REFRESH_MS,
    refreshDebounceMs: ENV.PYTH_REFRESH_DEBOUNCE_MS,
  });

  const config: ApiConfig = { pythSymbolMonitor, planner };
  await initBackgroundServices(config);
  await initApiService(config);
}

registerShutdownConfig();
initApp()
  .then(() => {
    logger.info('App initialized');
  })
  .catch(error => {
    logger.error(error, 'App failed to start');
    process.exit(1);
  });
