import { Router, type Request } from 'express';
import type { DataSource } from 'typeorm';
import type { Organization } from '@acme/contracts';
import { NoteEntity, type Note } from '../../infrastructure/schema';
import { AccessDenied, withIdentity } from '../../infrastructure/tenant-database';
import type { Cache } from '../../infrastructure/cache';
import { enqueue } from '../../infrastructure/outbox';
import { logger } from '../../observability/logger';

const noteFields = { id: true, body: true, createdBy: true, createdAt: true } as const;
const serializeNote = (row: Note) => ({ id: row.id, body: row.body, createdBy: row.createdBy, createdAt: row.createdAt.toISOString() });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class InvalidRequest extends Error { status = 400; }
export function tenant(req: Request) {
  const id = req.get('X-Tenant-ID');
  if (!id || !uuid.test(id)) throw new InvalidRequest('X-Tenant-ID must be an organization UUID');
  return id;
}
function text(value: unknown, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new InvalidRequest('Invalid text');
  return value.trim();
}
export function createOrganizationsModule(pool: DataSource, cache?: Cache, events = false) {
  const router = Router();
  router.get('/organizations', async (_req, res) => {
    const result = await withIdentity(pool, res.locals.auth, async (db) => {
      return db.sql<Organization[]>`SELECT id,name,tenancy.member_role(id) AS role FROM tenancy.organizations ORDER BY name,id`;
    });
    res.json({ organizations: result });
  });
  router.post('/organizations', async (req, res) => {
    const name = text(req.body?.name, 100);
    const organization = await withIdentity(pool, res.locals.auth, async (db) => {
      const result = await db.sql<{ id: string }[]>`SELECT tenancy.create_organization(${name}) AS id`;
      return { id: result[0]!.id, name, role: 'owner' as const };
    });
    logger.info({ event: 'organization.created', tenantId: organization.id }, 'Organization created');
    res.status(201).json(organization);
  });
  router.get('/organization/members', async (req, res) => {
    const members = await withIdentity(pool, res.locals.auth, async (db) => {
      return db.sql`SELECT user_id AS "userId",display_name AS "displayName",role FROM tenancy.list_members(${tenant(req)})`;
    }, tenant(req));
    res.json({ members });
  });
  // Registered users share their /api/me ID with an administrator. No email lookup or auto-join.
  router.put('/organization/members/:userId', async (req, res) => {
    const org = tenant(req);
    const userId = String(req.params.userId);
    if (!uuid.test(userId) || !['admin', 'member'].includes(req.body?.role)) throw new InvalidRequest('Invalid member');
    // set_member takes an exclusive lock itself. Do not upgrade a SHARE lock here.
    await withIdentity(pool, res.locals.auth, async (db) => {
      await db.sql`SELECT tenancy.set_member(${org}, ${userId}, ${req.body.role})`;
    });
    logger.info({ event: 'membership.changed', tenantId: org, memberId: userId, role: req.body.role }, 'Membership changed');
    res.status(204).end();
  });
  router.delete('/organization/members/:userId', async (req, res) => {
    const org = tenant(req);
    const userId = String(req.params.userId);
    if (!uuid.test(userId)) throw new InvalidRequest('Invalid member');
    await withIdentity(pool, res.locals.auth, async (db) => { await db.sql`SELECT tenancy.set_member(${org}, ${userId}, NULL)`; });
    logger.info({ event: 'membership.removed', tenantId: org, memberId: userId }, 'Membership removed');
    res.status(204).end();
  });
  router.get('/organization/notes', async (req, res) => {
    const result = await withIdentity(pool, res.locals.auth, async (db) => {
      const version = await db.sql<{ version: string }[]>`SELECT version FROM tenancy.note_cache_versions`;
      const key = `notes:v1:${tenant(req)}:${version[0]?.version ?? '0'}`;
      const cached = await cache?.get<unknown[]>(key);
      if (cached) return cached;
      // Deliberately no tenant WHERE: RLS is a second enforced boundary.
      const rows = await db.getRepository(NoteEntity).find({ select: noteFields, order: { createdAt: 'DESC', id: 'ASC' }, take: 100 });
      const result = rows.map(serializeNote);
      await cache?.set(key, result);
      return result;
    }, tenant(req));
    res.json({ notes: result });
  });
  router.post('/organization/notes', async (req, res) => {
    const body = text(req.body?.body, 2000);
    const org = tenant(req);
    const note = await withIdentity(pool, res.locals.auth, async (db) => {
      const result = await db.createQueryBuilder().insert().into(NoteEntity).values({ organizationId: org, body, createdBy: () => 'tenancy.actor_id()' }).returning(['id','body','createdBy','createdAt']).execute();
      const row = result.raw[0];
      if (!row) throw new Error('Note creation failed');
      if (events) await enqueue(db, org, 'event', { type: 'note.created.v1', noteId: row.id });
      return { id: row.id, body: row.body, createdBy: row.created_by, createdAt: row.created_at.toISOString() };
    }, org);
    res.status(201).json(note);
  });
  router.delete('/organization/notes/:noteId', async (req, res) => {
    if (!uuid.test(String(req.params.noteId))) throw new InvalidRequest('Invalid note');
    const removed = await withIdentity(pool, res.locals.auth, async (db) => {
      const result = await db.getRepository(NoteEntity).delete({ id: String(req.params.noteId) });
      return result.affected;
    }, tenant(req));
    if (!removed) { res.status(404).json({ error: 'Note not found' }); return; }
    res.status(204).end();
  });
  // Translate database permission errors without exposing SQL or identities.
  router.use((error: unknown, _req: Request, _res: unknown, next: (error: unknown) => void) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    if (code === '42501') next(new AccessDenied('Insufficient permission'));
    else if (code === '23503' || code === '23514') next(new InvalidRequest('Invalid member or content'));
    else next(error);
  });
  return router;
}
