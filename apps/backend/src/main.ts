import { shutdownTelemetry } from './observability/telemetry';
import { createCache } from './infrastructure/cache';
import { createJobsModule } from './modules/jobs';
import { logger } from './observability/logger';
import { createOrganizationsModule } from './modules/organizations';
import { createServer } from 'node:http';
import { createApp } from './app';
import { createDatabase, databaseReady, assertRuntimeRole } from './infrastructure/database';
import { createAccountsModule } from './modules/accounts';
import { readAuthConfig, requireAuth } from './auth';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
let ready = true;
const database = createDatabase();
const cache = createCache();
const asyncEnabled = process.env.ASYNC_ENABLED === 'true';
const server = createServer(createApp(
  async () => ready && await databaseReady(database),
  requireAuth(readAuthConfig()),
  [createAccountsModule(database), createOrganizationsModule(database, cache, asyncEnabled), ...(asyncEnabled ? [createJobsModule(database)] : [])],
));
server.on('error', (error) => { logger.error({ event: 'server.error', errorType: error.name }, 'Server failed'); process.exit(1); });
void database.initialize().then(() => assertRuntimeRole(database)).then(() => {
  server.listen(port, '0.0.0.0', () => logger.info({ event: 'listening', port }, 'Backend listening'));
}).catch(async () => {
  logger.fatal({ event: 'database.unsafe_role' }, 'Database role or migrations are not ready');
  if (database.isInitialized) await database.destroy();
  await shutdownTelemetry();
  process.exitCode = 1;
});

function shutdown(signal: string) {
  if (!ready) return;
  ready = false;
  cache?.close();
  logger.info({ event: 'shutdown', signal }, 'Draining backend');
  // Allow endpoint removal to propagate before closing the listener.
  setTimeout(() => {
    server.close((error) => {
      void database.destroy().then(() => shutdownTelemetry()).then(() => process.exit(error ? 1 : 0), () => process.exit(1));
    });
  }, 5_000).unref();
  setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 25_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
