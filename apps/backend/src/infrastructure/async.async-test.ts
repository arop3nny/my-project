import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { Queue } from 'bullmq';
import { createDatabase, assertRuntimeRole } from './database';
import { createApp } from '../app';
import { requireAuth } from '../auth';
import { createAccountsModule } from '../modules/accounts';
import { createOrganizationsModule } from '../modules/organizations';
import { createJobsModule } from '../modules/jobs';
import { createCache } from './cache';
import { startAsyncWorker } from './async-worker';
import { redisOptions, queueName, createKafka, eventTopic } from './async-config';
import { withIdentity } from './tenant-database';
import { enqueue } from './outbox';

if (process.env.ASYNC_TEST_DISPOSABLE !== 'true') throw new Error('Use a disposable PostgreSQL/Redis/Kafka stack and set ASYNC_TEST_DISPOSABLE=true');
const owner = createDatabase();
const api = createDatabase({ ...process.env, PGUSER: 'platform_runtime', PGPASSWORD: process.env.POSTGRES_RUNTIME_PASSWORD });
const jobs = createDatabase({ ...process.env, PGUSER: 'platform_worker', PGPASSWORD: (process.env.POSTGRES_WORKER_PASSWORD || process.env.POSTGRES_RUNTIME_PASSWORD) });
let worker: Awaited<ReturnType<typeof startAsyncWorker>> | undefined;
let cache: ReturnType<typeof createCache>;
let app: ReturnType<typeof createApp>;
let alice: string; let bob: string; let bobId: string; let orgA: string; let orgB: string;
const issuer = 'https://auth.example.com/realms/platform';
const subject = randomUUID();
async function eventually(check: () => Promise<boolean>, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(200); }
  throw new Error('Timed out waiting for async result');
}
beforeAll(async () => {
  await Promise.all([owner.initialize(), api.initialize(), jobs.initialize()]);
  await expect(assertRuntimeRole(jobs)).rejects.toThrow();
  await assertRuntimeRole(jobs, 'worker');
  cache = createCache();
  const keys = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'async', alg: 'RS256' }] });
  const sign = (sub: string) => new SignJWT({ typ: 'Bearer', preferred_username: sub }).setProtectedHeader({ alg: 'RS256', kid: 'async' })
    .setIssuer(issuer).setAudience('platform-api').setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(keys.privateKey);
  alice = await sign(subject); bob = await sign(randomUUID());
  app = createApp(() => true, requireAuth({ issuer, audience: 'platform-api' }, jwks), [createAccountsModule(api), createOrganizationsModule(api, cache, true), createJobsModule(api)]);
  await request(app).get('/api/me').auth(alice, { type: 'bearer' }).expect(200);
  bobId = (await request(app).get('/api/me').auth(bob, { type: 'bearer' }).expect(200)).body.id;
  orgA = (await request(app).post('/api/organizations').auth(alice, { type: 'bearer' }).send({ name: 'Async Alice' }).expect(201)).body.id;
  orgB = (await request(app).post('/api/organizations').auth(bob, { type: 'bearer' }).send({ name: 'Async Bob' }).expect(201)).body.id;
});
afterAll(async () => {
  await worker?.close(); cache?.close();
  for (const db of [api, jobs, owner]) if (db.isInitialized) await db.destroy();
});
const get = (token: string, org: string, path: string) => request(app).get(`/api/organization/${path}`).auth(token, { type: 'bearer' }).set('X-Tenant-ID', org);
const post = (token: string, org: string, path: string) => request(app).post(`/api/organization/${path}`).auth(token, { type: 'bearer' }).set('X-Tenant-ID', org);

it('isolates cached notes, invalidates writes and commits events atomically', async () => {
  await post(alice, orgA, 'notes').send({ body: 'Alice private' }).expect(201);
  await post(bob, orgB, 'notes').send({ body: 'Bob private' }).expect(201);
  for (let i = 0; i < 2; i++) expect((await get(alice, orgA, 'notes').expect(200)).body.notes.map((n: { body: string }) => n.body)).toEqual(['Alice private']);
  await get(bob, orgA, 'notes').expect(403);
  const second = (await post(alice, orgA, 'notes').send({ body: 'New note' }).expect(201)).body;
  expect((await get(alice, orgA, 'notes')).body.notes).toHaveLength(2);
  await request(app).delete(`/api/organization/notes/${second.id}`).auth(alice, { type: 'bearer' }).set('X-Tenant-ID', orgA).expect(204);
  expect((await get(alice, orgA, 'notes')).body.notes).toHaveLength(1);
  const before = await owner.query('SELECT id FROM messaging.outbox');
  await expect(withIdentity(api, { iss: issuer, sub: subject }, async (manager) => {
    await enqueue(manager, orgA, 'event', { type: 'note.created.v1', noteId: randomUUID() });
    throw new Error('Abort');
  }, orgA)).rejects.toThrow('Abort');
  expect(await owner.query('SELECT id FROM messaging.outbox')).toEqual(before);
  await expect(api.query('SELECT * FROM messaging.outbox')).rejects.toThrow();
});
it('delivers delayed jobs once, publishes Kafka events and deduplicates replay', async () => {
  const id = randomUUID();
  await post(alice, orgA, 'jobs/notes-report').set('Idempotency-Key', id).send({ delaySeconds: 2 }).expect(202);
  await post(alice, orgA, 'jobs/notes-report').set('Idempotency-Key', id).send({ delaySeconds: 2 }).expect(202);
  await post(alice, orgA, 'jobs/notes-report').set('Idempotency-Key', id).send({ delaySeconds: 3 }).expect(409);
  expect((await get(bob, orgB, 'jobs')).body.jobs).toEqual([]);
  worker = await startAsyncWorker(jobs);
  await eventually(async () => (await get(alice, orgA, 'jobs')).body.jobs.some((job: { id: string; status: string }) => job.id === id && job.status === 'completed'));
  const row = (await owner.query('SELECT * FROM tenancy.jobs WHERE id=$1', [id]))[0];
  expect(row.result.noteCount).toBe(1);
  expect(row.completed_at.getTime()).toBeGreaterThanOrEqual(row.run_after.getTime());
  const record = (await owner.query("SELECT * FROM messaging.outbox WHERE organization_id=$1 AND destination='event' ORDER BY created_at LIMIT 1", [orgA]))[0];
  await eventually(async () => (await owner.query('SELECT event_id FROM messaging.inbox WHERE event_id=$1', [record.id])).length === 1);
  const producer = createKafka().producer({ allowAutoTopicCreation: false });
  try {
    await producer.connect();
    await producer.send({ topic: eventTopic, acks: -1, messages: [{ key: orgA, value: JSON.stringify({ id: record.id, type: 'note.created.v1', organizationId: orgA }) }] });
    await delay(1000);
    expect(await owner.query('SELECT event_id FROM messaging.inbox WHERE event_id=$1', [record.id])).toHaveLength(1);
  } finally { await producer.disconnect(); }
  // Redelivery after an acknowledgement loss cannot recalculate a completed report.
  const queue = new Queue(queueName, { connection: redisOptions('QUEUE') });
  try {
    const queued = await queue.getJob(id);
    expect(queued).toBeDefined();
    await queued!.retry('completed');
    await eventually(async () => await queued!.getState() === 'completed');
    expect((await owner.query('SELECT result FROM tenancy.jobs WHERE id=$1', [id]))[0].result).toEqual(row.result);
  } finally { await queue.close(); }
});
it('cancels queued work after membership revocation and survives a worker restart', async () => {
  await worker!.close(); worker = undefined;
  await request(app).put(`/api/organization/members/${bobId}`).auth(alice, { type: 'bearer' }).set('X-Tenant-ID', orgA).send({ role: 'member' }).expect(204);
  await get(bob, orgA, 'notes').expect(200); // Populate/read shared cache while authorized.
  const id = randomUUID();
  await post(bob, orgA, 'jobs/notes-report').set('Idempotency-Key', id).send({}).expect(202);
  await request(app).delete(`/api/organization/members/${bobId}`).auth(alice, { type: 'bearer' }).set('X-Tenant-ID', orgA).expect(204);
  await get(bob, orgA, 'notes').expect(403);
  worker = await startAsyncWorker(jobs);
  await eventually(async () => (await owner.query('SELECT status FROM tenancy.jobs WHERE id=$1', [id]))[0].status === 'cancelled');
  expect((await owner.query('SELECT result FROM tenancy.jobs WHERE id=$1', [id]))[0].result).toBeNull();
  cache?.close();
  expect((await get(alice, orgA, 'notes').expect(200)).body.notes).toHaveLength(1);
});
it('recovers accepted job intent when its delivered queue entry is lost', async () => {
  await worker!.close(); worker = undefined;
  const id = randomUUID();
  await post(alice, orgA, 'jobs/notes-report').set('Idempotency-Key', id).send({}).expect(202);
  // Simulate loss after a broker acknowledgement, without flushing other queue entries.
  await owner.query("UPDATE messaging.outbox SET delivered_at=now() WHERE destination='job' AND payload->>'jobId'=$1", [id]);
  worker = await startAsyncWorker(jobs);
  await eventually(async () => (await owner.query('SELECT status FROM tenancy.jobs WHERE id=$1', [id]))[0].status === 'completed');
  expect((await owner.query('SELECT result FROM tenancy.jobs WHERE id=$1', [id]))[0].result.noteCount).toBe(1);
});
