// Run only against the disposable PostgreSQL service and local telemetry stack.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

assert.equal(process.env.SMOKE_TEST_DISPOSABLE, 'true', 'This test creates account data; use a disposable database');
assert.ok(process.env.GRAFANA_ADMIN_PASSWORD, 'Set the disposable Grafana admin password');
const keys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'smoke', alg: 'RS256' };
const issuerServer = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
issuerServer.listen(0, '127.0.0.1');
await once(issuerServer, 'listening');
const issuer = `http://127.0.0.1:${issuerServer.address().port}/realms/platform`;
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const instance = `smoke-${randomUUID()}`;
const child = spawn(process.execPath, ['dist/apps/backend/main.cjs'], {
  env: { ...process.env, NODE_ENV: 'development', PORT: String(port), AUTH_ISSUER: issuer, PGUSER: 'platform_runtime', PGPASSWORD: process.env.POSTGRES_RUNTIME_PASSWORD,
    HOSTNAME: instance, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_TRACES_SAMPLER: 'always_on' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const exit = once(child, 'exit');
async function eventually(check, description) {
  let last;
  for (let i = 0; i < 45; i++) {
    try { return await check(); } catch (error) { last = error; await delay(1000); }
  }
  throw new Error(`${description}: ${last?.message}`);
}
const base = `http://127.0.0.1:${port}`;
const grafanaHeaders = { Authorization: `Basic ${Buffer.from(`admin:${process.env.GRAFANA_ADMIN_PASSWORD}`).toString('base64')}` };
async function dataSource(uid, path) {
  const response = await fetch(`http://127.0.0.1:3001/api/datasources/proxy/uid/${uid}${path}`, { headers: grafanaHeaders, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, `${uid} query failed`);
  return response.json();
}
try {
  await eventually(async () => {
    assert.equal(child.exitCode, null, 'Backend exited before readiness');
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
  }, 'Backend readiness');
  const token = await new SignJWT({ typ: 'Bearer', preferred_username: 'Telemetry test' }).setProtectedHeader({ alg: 'RS256', kid: 'smoke' }).setIssuer(issuer).setAudience('platform-api').setSubject(instance).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/me`, { headers })).status, 200);
  const organization = await fetch(`${base}/api/organizations`, { method: 'POST', headers, body: JSON.stringify({ name: 'Telemetry smoke' }) });
  assert.equal(organization.status, 201);
  const tenant = (await organization.json()).id;
  const note = await fetch(`${base}/api/organization/notes?token=never-log-query`, { method: 'POST', headers: { ...headers, 'X-Tenant-ID': tenant }, body: JSON.stringify({ body: 'never-log-note-body' }) });
  assert.equal(note.status, 201);
  const requestId = note.headers.get('x-request-id');
  const record = await eventually(() => {
    const result = output.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((item) => item.requestId === requestId);
    assert.ok(result?.trace_id, 'No correlated request trace'); return result;
  }, 'Correlated log');
  assert.equal(record.tenantId, tenant);
  assert.ok(!output.includes('never-log-note-body') && !output.includes('never-log-query') && !output.includes(token));
  await eventually(async () => {
    const result = await dataSource('prometheus', `/api/v1/query?query=${encodeURIComponent(`http_server_requests_total{service_instance_id="${instance}"}`)}`);
    assert.ok(result.data.result.length > 0, 'No backend request metrics');
  }, 'Prometheus ingestion');
  await eventually(async () => {
    const result = await dataSource('loki', `/loki/api/v1/query_range?query=${encodeURIComponent(`{service_name="platform-backend"} |= "${requestId}"`)}`);
    assert.ok(result.data.result.length > 0, 'No correlated central log');
    assert.ok(!JSON.stringify(result).includes('never-log-note-body'));
  }, 'Loki ingestion');
  await eventually(async () => {
    const result = await dataSource('tempo', `/api/traces/${record.trace_id}`);
    assert.ok(JSON.stringify(result).includes('postgres.transaction'), 'No database child span');
  }, 'Tempo ingestion');
  console.log('Verified: bundled backend -> OTLP collector -> Prometheus, Loki and Tempo -> Grafana; tenant correlation and sensitive-data omission.');
} catch (error) {
  // Output contains only application-approved structured fields, never the generated JWT.
  console.error(output.slice(-5000));
  throw error;
} finally {
  child.kill('SIGTERM');
  await exit;
  issuerServer.close();
}
