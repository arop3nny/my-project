import { NoteEntity } from './schema';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { createDatabase, databaseReady, assertRuntimeRole } from './database';
import { migrate, migrationStatus } from './migrations';
import { createApp } from '../app';
import { requireAuth } from '../auth';
import { createAccountsModule } from '../modules/accounts';
import { createOrganizationsModule } from '../modules/organizations';
import { withIdentity } from './tenant-database';

const databaseName = `platform_test_${randomUUID().replaceAll('-', '')}`;
let admin: DataSource;
let pool: DataSource;
let runtime: DataSource;
const ownerRole = `owner_${databaseName}`;
const runtimeRole = `runtime_${databaseName}`;
const ownerPassword = randomUUID();
const runtimePassword = randomUUID();
let createdGroup = false;
let createdWorkerGroup = false;
let created = false;

beforeAll(async () => {
  // Only the new, randomly named database is mutated or deleted by this suite.
  admin = createDatabase({ ...process.env, NODE_ENV: 'test' });
  await admin.initialize();
  const group = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'platform_runtime'");
  if (!group.length) { await admin.query('CREATE ROLE platform_runtime NOLOGIN'); createdGroup = true; }
  const workerGroup = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'platform_worker'");
  if (!workerGroup.length) { await admin.query('CREATE ROLE platform_worker NOLOGIN IN ROLE platform_runtime'); createdWorkerGroup = true; }
  // Generated UUID passwords and identifiers are local test fixtures only.
  await admin.query(`CREATE ROLE "${ownerRole}" LOGIN PASSWORD '${ownerPassword}'`);
  await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}' IN ROLE platform_runtime`);
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  created = true;
  pool = createDatabase({ ...process.env, NODE_ENV: 'test', PGDATABASE: databaseName, PGUSER: ownerRole, PGPASSWORD: ownerPassword });
  runtime = createDatabase({ ...process.env, NODE_ENV: 'test', PGDATABASE: databaseName, PGUSER: runtimeRole, PGPASSWORD: runtimePassword });
  await pool.initialize();
  await runtime.initialize();
});
afterAll(async () => {
  if (pool?.isInitialized) await pool.destroy();
  if (runtime?.isInitialized) await runtime.destroy();
  if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin?.query(`DROP ROLE IF EXISTS "${runtimeRole}", "${ownerRole}"`);
  if (createdWorkerGroup) await admin.query('DROP ROLE platform_worker');
  if (createdGroup) await admin.query('DROP ROLE platform_runtime');
  if (admin?.isInitialized) await admin.destroy();
});

it('applies migrations once and provisions accounts only from verified claims', async () => {
  await migrate(pool);
  await migrate(pool);
  expect((await pool.query('SELECT * FROM public.typeorm_migrations')).length).toBe(3);
  expect(await databaseReady(pool)).toBe(true);
  const keys = await generateKeyPair('RS256');
  const issuer = 'https://auth.example.com/realms/platform';
  const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'integration', alg: 'RS256' }] });
  const existing = await pool.query("INSERT INTO accounts.profiles(issuer, subject, display_name) VALUES ($1, 'user-one', 'Existing account') RETURNING id", [issuer]);
  const app = createApp(() => databaseReady(pool), requireAuth({ issuer, audience: 'platform-api' }, jwks), [createAccountsModule(runtime), createOrganizationsModule(runtime)]);
  const sign = (subject: string) => new SignJWT({ typ: 'Bearer', preferred_username: "Taylor's workspace" })
    .setProtectedHeader({ alg: 'RS256', kid: 'integration' }).setIssuer(issuer)
    .setAudience('platform-api').setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  await request(app).get('/api/me').expect(401);
  const first = await request(app).get('/api/me').auth(await sign('user-one'), { type: 'bearer' }).expect(200);
  const repeat = await request(app).get('/api/me?subject=user-two').auth(await sign('user-one'), { type: 'bearer' }).expect(200);
  const second = await request(app).get('/api/me').auth(await sign('user-two'), { type: 'bearer' }).expect(200);
  expect(first.body.id).toBe(existing[0].id);
  expect(first.body.id).toBe(repeat.body.id);
  expect(first.body.joinedAt).toBe(repeat.body.joinedAt);
  expect(first.body.id).not.toBe(second.body.id);
  expect(first.body.displayName).toBe("Taylor's workspace");
  expect((await pool.query('SELECT * FROM accounts.profiles')).length).toBe(2);
  await request(app).get('/health/ready').expect(200);
});
it('rolls back failed native migrations without advancing history', async () => {
  class Failure1788451203000 implements MigrationInterface {
    async up(runner: QueryRunner) { await runner.query('CREATE TABLE should_rollback(id int)'); await runner.query('SELECT definitely_not_a_function()'); }
    async down(runner: QueryRunner) { await runner.query('DROP TABLE should_rollback'); }
  }
  pool.migrations.push(new Failure1788451203000());
  try {
    await expect(migrate(pool)).rejects.toThrow();
    expect((await pool.query("SELECT to_regclass('should_rollback') AS name"))[0].name).toBeNull();
    expect((await pool.query('SELECT * FROM public.typeorm_migrations')).length).toBe(3);
  } finally { pool.migrations.pop(); }
});

it('uses a restricted runtime role and enforces tenant isolation, permissions and revocation', async () => {
  await assertRuntimeRole(runtime);
  await expect(assertRuntimeRole(pool)).rejects.toThrow('non-owner');
  const keys = await generateKeyPair('RS256');
  const issuer = 'https://auth.example.com/realms/platform';
  const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'tenant', alg: 'RS256' }] });
  const app = createApp(() => true, requireAuth({ issuer, audience: 'platform-api' }, jwks), [createAccountsModule(runtime), createOrganizationsModule(runtime)]);
  const sign = (subject: string) => new SignJWT({ typ: 'Bearer', preferred_username: subject })
    .setProtectedHeader({ alg: 'RS256', kid: 'tenant' }).setIssuer(issuer)
    .setAudience('platform-api').setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const alice = await sign('alice'); const bob = await sign('bob'); const carol = await sign('carol');
  const me = async (token: string) => (await request(app).get('/api/me').auth(token, { type: 'bearer' }).expect(200)).body.id as string;
  const aliceId = await me(alice); const bobId = await me(bob); const carolId = await me(carol);
  const create = async (token: string, name: string) => (await request(app).post('/api/organizations').auth(token, { type: 'bearer' }).send({ name }).expect(201)).body.id as string;
  const a = await create(alice, 'Alice organization'); const b = await create(bob, 'Bob organization');
  const call = (token: string, org: string) => ({
    get: (path: string) => request(app).get(path).auth(token, { type: 'bearer' }).set('X-Tenant-ID', org),
    post: (path: string) => request(app).post(path).auth(token, { type: 'bearer' }).set('X-Tenant-ID', org),
    put: (path: string) => request(app).put(path).auth(token, { type: 'bearer' }).set('X-Tenant-ID', org),
    delete: (path: string) => request(app).delete(path).auth(token, { type: 'bearer' }).set('X-Tenant-ID', org),
  });
  const aliceOrg = call(alice, a); const bobOrg = call(bob, b);
  const note = (await aliceOrg.post('/api/organization/notes').send({ body: "Alice's private note" }).expect(201)).body;
  expect(note.body).toBe("Alice's private note");
  expect(note.createdBy).toBe(aliceId);
  expect(new Date(note.createdAt).toISOString()).toBe(note.createdAt);
  expect(Object.keys(note).sort()).toEqual(['body', 'createdAt', 'createdBy', 'id']);
  await bobOrg.post('/api/organization/notes').send({ body: 'Bob private note' }).expect(201);
  await request(app).get('/api/organization/notes').auth(alice, { type: 'bearer' }).expect(400);
  await call(alice, 'invalid').get('/api/organization/notes').expect(400);
  await call(alice, b).get('/api/organization/notes').expect(403);
  await call(alice, b).post('/api/organization/notes').send({ body: 'forged' }).expect(403);
  await bobOrg.delete(`/api/organization/notes/${note.id}`).expect(404);
  const orgs = await request(app).get('/api/organizations').auth(alice, { type: 'bearer' }).expect(200);
  expect(orgs.body.organizations.map((org: { id: string }) => org.id)).toEqual([a]);

  // Application bugs omitting predicates still cannot read or write another tenant.
  const identity = { iss: issuer, sub: 'alice' };
  const direct = await withIdentity(runtime, identity, (db) => db.getRepository(NoteEntity).find({ select: { body: true } }), a);
  expect(direct.map((row) => row.body)).toEqual(["Alice's private note"]);
  await expect(withIdentity(runtime, identity, (db) => db.getRepository(NoteEntity).insert({ organizationId: b, body: 'forged', createdBy: aliceId }), a)).rejects.toMatchObject({ code: '42501' });
  await expect(withIdentity(runtime, identity, async (db) => {
    await db.getRepository(NoteEntity).insert({ organizationId: a, body: 'Must roll back', createdBy: aliceId });
    throw new Error('Abort tenant transaction');
  }, a)).rejects.toThrow('Abort tenant transaction');
  expect(await withIdentity(runtime, identity, (db) => db.getRepository(NoteEntity).find({ select: { body: true } }), a)).toEqual([{ body: "Alice's private note" }]);
  expect((await withIdentity(runtime, identity, (db) => db.query('SELECT * FROM tenancy.notes')))).toEqual([]);
  expect((await runtime.query('SELECT * FROM tenancy.notes'))).toEqual([]);
  await expect(runtime.query("UPDATE tenancy.memberships SET role = 'owner'")).rejects.toMatchObject({ code: '42501' });
  await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const response = await (i % 2 ? aliceOrg : bobOrg).get('/api/organization/notes').expect(200);
    expect(response.body.notes.map((item: { body: string }) => item.body)).toEqual([i % 2 ? "Alice's private note" : 'Bob private note']);
  }));

  await aliceOrg.put(`/api/organization/members/${bobId}`).send({ role: 'member' }).expect(204);
  await call(bob, a).get('/api/organization/notes').expect(200);
  const members = await call(bob, a).get('/api/organization/members').expect(200);
  expect(members.body.members).toEqual(expect.arrayContaining([{ userId: aliceId, displayName: 'alice', role: 'owner' }, { userId: bobId, displayName: 'bob', role: 'member' }]));
  await call(bob, a).put(`/api/organization/members/${carolId}`).send({ role: 'admin' }).expect(403);
  await aliceOrg.put(`/api/organization/members/${bobId}`).send({ role: 'admin' }).expect(204);
  await call(bob, a).put(`/api/organization/members/${carolId}`).send({ role: 'admin' }).expect(403);
  await call(bob, a).put(`/api/organization/members/${carolId}`).send({ role: 'member' }).expect(204);
  await call(bob, a).delete(`/api/organization/members/${aliceId}`).expect(403);
  await aliceOrg.delete(`/api/organization/members/${aliceId}`).expect(403);
  await aliceOrg.delete(`/api/organization/members/${bobId}`).expect(204);
  await call(bob, a).get('/api/organization/notes').expect(403);
  await call(bob, a).post('/api/organization/notes').send({ body: 'revoked' }).expect(403);
  // Revocation also applies when bypassing the HTTP authorization layer.
  expect(await withIdentity(runtime, { iss: issuer, sub: 'bob' }, (db) => db.getRepository(NoteEntity).findBy({ organizationId: a }))).toEqual([]);
});

it('rolls back and reapplies TypeORM migrations', async () => {
  const profilesBefore = (await pool.query('SELECT id FROM accounts.profiles'));
  await migrate(pool, 'down');
  expect((await pool.query("SELECT to_regclass('tenancy.jobs') AS name"))[0].name).toBeNull();
  expect((await migrationStatus(pool)).at(-1)?.status).toBe('pending');
  expect((await pool.query('SELECT id FROM accounts.profiles'))).toEqual(profilesBefore);
  await migrate(pool);
  expect((await migrationStatus(pool)).every((item) => item.status === 'applied')).toBe(true);
  for (let i = 0; i < 3; i++) await migrate(pool, 'down');
  expect((await pool.query("SELECT to_regclass('accounts.profiles') AS name"))[0].name).toBeNull();
  await migrate(pool);
  expect((await migrationStatus(pool)).every((item) => item.status === 'applied')).toBe(true);
});
