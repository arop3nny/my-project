import { Router } from 'express';
import type { DataSource } from 'typeorm';
import { withIdentity } from '../../infrastructure/tenant-database';
import { enqueue } from '../../infrastructure/outbox';
import { tenant } from '../organizations';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createJobsModule(pool: DataSource) {
  const router = Router();
  router.post('/organization/jobs/notes-report', async (req, res) => {
    const org = tenant(req);
    const id = req.get('Idempotency-Key');
    const delay = req.body?.delaySeconds ?? 0;
    if (!id || !uuid.test(id) || !Number.isInteger(delay) || delay < 0 || delay > 2592000) {
      res.status(400).json({ error: 'UUID Idempotency-Key and delaySeconds between 0 and 2592000 required' }); return;
    }
    const job = await withIdentity(pool, res.locals.auth, async (db) => {
      const inserted = await db.sql`INSERT INTO tenancy.jobs(id,organization_id,requested_by,kind,delay_seconds,run_after)
        VALUES (${id},${org},tenancy.actor_id(),'notes-report',${delay},now()+${delay}*interval '1 second')
        ON CONFLICT (id) DO NOTHING RETURNING id,status,run_after`;
      if (inserted[0]) {
        await enqueue(db, org, 'job', { jobId: id, runAfter: (inserted[0].run_after as Date).toISOString() });
        return inserted[0];
      }
      const existing = await db.sql`SELECT id,status,run_after FROM tenancy.jobs WHERE id=${id} AND delay_seconds=${delay}`;
      return existing[0];
    }, org);
    if (!job) { res.status(409).json({ error: 'Idempotency key already used for a different request' }); return; }
    res.status(202).json(job);
  });
  router.get('/organization/jobs', async (req, res) => {
    const result = await withIdentity(pool, res.locals.auth, (db) => db.sql`SELECT id,kind,status,result,failure_code,run_after,created_at,completed_at FROM tenancy.jobs ORDER BY created_at DESC LIMIT 100`, tenant(req));
    res.json({ jobs: result });
  });
  return router;
}
