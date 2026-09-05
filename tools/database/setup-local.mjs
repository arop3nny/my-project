import { Pool } from 'pg';
const host = process.env.PGHOST ?? 'localhost';
if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('This helper is only for local development');
const password = process.env.POSTGRES_RUNTIME_PASSWORD;
if (!password || !process.env.POSTGRES_PASSWORD) throw new Error('Set POSTGRES_PASSWORD and POSTGRES_RUNTIME_PASSWORD in .env');
const pool = new Pool({ host, port: Number(process.env.PGPORT ?? 5433), database: 'platform', user: 'platform', password: process.env.POSTGRES_PASSWORD });
try {
  await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='platform_runtime') THEN CREATE ROLE platform_runtime; END IF; END $$");
  const result = await pool.query("SELECT format('ALTER ROLE platform_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text) AS statement", [password]);
  await pool.query(result.rows[0].statement);
  await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='platform_worker') THEN CREATE ROLE platform_worker IN ROLE platform_runtime; END IF; END $$");
  const worker = await pool.query("SELECT format('ALTER ROLE platform_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text) AS statement", [process.env.POSTGRES_WORKER_PASSWORD || password]);
  await pool.query(worker.rows[0].statement);
  console.log('Local runtime role configured. Next: pnpm exec nx run backend:migrate');
} finally { await pool.end(); }
