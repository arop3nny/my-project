import { type DataSource, MigrationExecutor } from 'typeorm';

export async function migrate(database: DataSource, action: 'up' | 'down' = 'up') {
  if (!database.isInitialized) await database.initialize();
  const runner = database.createQueryRunner();
  await runner.connect();
  try {
    await runner.query('SELECT pg_advisory_lock(741852963)');
    const executor = new MigrationExecutor(database, runner);
    executor.transaction = 'all';
    if (action === 'up') await executor.executePendingMigrations();
    else await executor.undoLastMigration();
  } finally {
    try { await runner.query('SELECT pg_advisory_unlock(741852963)'); }
    finally { await runner.release(); }
  }
}
export async function migrationStatus(database: DataSource) {
  if (!database.isInitialized) await database.initialize();
  const executor = new MigrationExecutor(database);
  const all = database.migrations.map((item) => ({ name: item.name ?? item.constructor.name }));
  const exists = (await database.query("SELECT to_regclass('public.typeorm_migrations') AS name"))[0].name;
  const executed = exists ? await executor.getExecutedMigrations() : [];
  return all.map((migration) => ({ migration: migration.name, status: executed.some((item) => item.name === migration.name) ? 'applied' : 'pending' }));
}
