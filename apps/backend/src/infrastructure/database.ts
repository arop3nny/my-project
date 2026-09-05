import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { entities } from './schema';

export function createDatabase(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  for (const key of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLROOTCERT']) {
    if (production && !env[key]) throw new Error(`${key} is required in production`);
  }
  const password = env.PGPASSWORD ?? env.POSTGRES_RUNTIME_PASSWORD;
  if (!password) throw new Error('Set PGPASSWORD or POSTGRES_RUNTIME_PASSWORD before starting the backend');
  return new DataSource({
    type: 'postgres', host: env.PGHOST ?? 'localhost', port: Number(env.PGPORT ?? (production ? 5432 : 5433)),
    database: env.PGDATABASE ?? 'platform', username: env.PGUSER ?? 'platform_runtime', password,
    ssl: production ? { ca: readFileSync(env.PGSSLROOTCERT!, 'utf8'), rejectUnauthorized: true } : false,
    entities, migrations: [resolve(env.MIGRATIONS_DIR ?? (production ? 'migrations' : 'apps/backend/migrations'), '*.{ts,cjs}')],
    migrationsTableName: 'typeorm_migrations', migrationsTransactionMode: 'all',
    synchronize: false, migrationsRun: false, logging: false,
    uuidExtension: 'pgcrypto', installExtensions: false,
    extra: { max: 10, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000, statement_timeout: 10000, application_name: env.OTEL_SERVICE_NAME ?? 'platform-backend' },
  });
}
export async function databaseReady(database: DataSource): Promise<boolean> {
  try { if (!database.isInitialized) return false; await database.query('SELECT 1'); return true; } catch { return false; }
}
export async function assertRuntimeRole(database: DataSource, purpose: 'api' | 'worker' = 'api') {
  const [role] = await database.query(`SELECT r.rolsuper,r.rolbypassrls,pg_has_role(current_user,c.relowner,'MEMBER') AS owns_data,
    pg_has_role(current_user,'platform_worker','MEMBER') AS worker_role,
    pg_has_role(current_user,'platform_runtime','MEMBER') AS runtime_role
    FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE r.rolname=current_user AND n.nspname='tenancy' AND c.relname='notes'`);
  if (!role || role.rolsuper || role.rolbypassrls || role.owns_data || !role.runtime_role || (purpose === 'api' ? role.worker_role : !role.worker_role)) throw new Error('Run migrations and use a non-owner, non-BYPASSRLS database role for the backend');
}
