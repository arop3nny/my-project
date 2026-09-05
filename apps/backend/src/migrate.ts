import { logger } from './observability/logger';
import { createDatabase } from './infrastructure/database';
import { migrate, migrationStatus } from './infrastructure/migrations';

const pool = createDatabase({ ...process.env, PGUSER: process.env.PGUSER ?? 'platform', PGPASSWORD: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD });
const action = process.argv[2] ?? 'up';
const run = async () => {
  if (action === 'status') { console.table(await migrationStatus(pool)); return; }
  if (action !== 'up' && action !== 'down') throw new Error('Expected up, down or status');
  await migrate(pool, action);
  console.log(action === 'up' ? 'Database is up to date' : 'Latest migration rolled back (if any)');
};
void run()
  .catch((error: unknown) => { logger.error({ event: 'migration.failed', errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Migration failed; inspect the migration with owner credentials'); process.exitCode = 1; })
  .finally(async () => { if (pool.isInitialized) await pool.destroy(); });
