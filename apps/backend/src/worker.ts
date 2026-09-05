import { shutdownTelemetry } from './observability/telemetry';
import { createServer } from 'node:http';
import { createDatabase, assertRuntimeRole, databaseReady } from './infrastructure/database';
import { startAsyncWorker } from './infrastructure/async-worker';
import { logger } from './observability/logger';

const pool = createDatabase({ ...process.env, PGUSER: process.env.PGUSER ?? 'platform_worker', PGPASSWORD: process.env.PGPASSWORD ?? (process.env.POSTGRES_WORKER_PASSWORD || process.env.POSTGRES_RUNTIME_PASSWORD) });
let runtime: Awaited<ReturnType<typeof startAsyncWorker>> | undefined;
let stopping = false;
const server = createServer((req, res) => {
  if (req.url === '/health/live') { res.writeHead(200).end('ok'); return; }
  if (req.url !== '/health/ready') { res.writeHead(404).end(); return; }
  void databaseReady(pool).then((db) => res.writeHead(!stopping && runtime?.ready() && db ? 200 : 503).end());
});
async function start() {
  await pool.initialize();
  await assertRuntimeRole(pool, 'worker');
  if (stopping) return;
  const port = Number(process.env.PORT ?? 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid worker port');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  if (stopping) return;
  runtime = await startAsyncWorker(pool);
  logger.info({ event: 'worker.started' }, 'Worker started');
}
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 80_000).unref();
  try {
    await startup.catch(() => {});
    await runtime?.close();
    server.close();
    if (pool.isInitialized) await pool.destroy();
    await shutdownTelemetry();
    clearTimeout(deadline);
  } catch { process.exitCode = 1; }
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
server.on('error', () => { process.exitCode = 1; void stop(); });
const startup = start();
void startup.catch(() => { logger.fatal({ event: 'worker.start_failed' }, 'Worker dependencies or role are not ready'); process.exitCode = 1; void stop(); });
