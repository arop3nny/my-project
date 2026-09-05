import { createDatabase } from './src/infrastructure/database';
export default createDatabase({ ...process.env, PGUSER: process.env.PGUSER ?? 'platform', PGPASSWORD: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD });
