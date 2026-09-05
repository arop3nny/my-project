import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GREETING_PATH } from '@acme/contracts';
import { createApp } from './app';
import { readAuthConfig, requireAuth } from './auth';

const config = { issuer: 'https://auth.example.com/realms/platform', audience: 'platform-api' };
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let app: ReturnType<typeof createApp>;
let authenticate: ReturnType<typeof requireAuth>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  authenticate = requireAuth(config, createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256' }] }));
  app = createApp(() => true, authenticate);
});

async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ typ: 'Bearer', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('user-123').setIssuedAt().setExpirationTime('5m')
    .setIssuer(config.issuer).setAudience(config.audience).sign(privateKey);
}

describe('authenticated API', () => {
  it('serves the greeting for a valid signed access token', async () => {
    const response = await request(app).get(GREETING_PATH).auth(await token(), { type: 'bearer' }).expect(200);
    expect(response.body).toEqual({ message: 'Your frontend and backend are connected.', service: 'backend' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
  it('requires authentication across the API namespace', async () => {
    await request(app).get(GREETING_PATH).expect(401);
    await request(app).get('/api/missing').expect(401);
  });
  it('rejects malformed tokens', async () => {
    await request(app).get(GREETING_PATH).auth('not-a-jwt', { type: 'bearer' }).expect(401);
  });
  it('rejects an ID token even with an API audience', async () => {
    await request(app).get(GREETING_PATH).auth(await token({ typ: 'ID' }), { type: 'bearer' }).expect(401);
  });
  it.each(['issuer', 'audience', 'expiry', 'signature'] as const)('rejects a token with the wrong %s', async (invalid) => {
    const key = invalid === 'signature' ? (await generateKeyPair('RS256')).privateKey : privateKey;
    const jwt = await new SignJWT({ typ: 'Bearer' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('user-123').setIssuedAt()
      .setIssuer(invalid === 'issuer' ? 'https://other.example.com' : config.issuer)
      .setAudience(invalid === 'audience' ? 'another-api' : config.audience)
      .setExpirationTime(invalid === 'expiry' ? '0s' : '5m').sign(key);
    await request(app).get(GREETING_PATH).auth(jwt, { type: 'bearer' }).expect(401);
  });
  it('keeps health endpoints public and reports draining readiness', async () => {
    const draining = createApp(() => false, authenticate);
    await request(draining).get('/health/live').expect(200);
    await request(draining).get('/health/ready').expect(503, { status: 'unavailable' });
  });
  it('returns JSON 404 for authenticated unknown routes', async () => {
    await request(app).get('/api/missing').auth(await token(), { type: 'bearer' }).expect(404, { error: 'Not found' });
  });
  it('rejects malformed JSON without exposing parser errors', async () => {
    await request(app).post('/api/example').set('Content-Type', 'application/json').send('{').expect(400, { error: 'Invalid request' });
  });
  it('requires explicit HTTPS issuer configuration in production', () => {
    expect(() => readAuthConfig({ NODE_ENV: 'production' })).toThrow('AUTH_ISSUER');
    expect(() => readAuthConfig({ NODE_ENV: 'production', AUTH_ISSUER: 'http://localhost:8081/realms/platform' })).toThrow('HTTPS');
    expect(readAuthConfig({ NODE_ENV: 'production', AUTH_ISSUER: config.issuer })).toEqual(config);
  });
});
