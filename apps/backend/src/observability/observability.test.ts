import { Writable } from 'node:stream';
import { afterAll, expect, it } from 'vitest';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { createLogger } from './logger';
import { requestContext } from './context';
import request from 'supertest';

const spans = new InMemorySpanExporter();
const records = new InMemoryLogRecordExporter();
const sdk = new NodeSDK({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })], logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: records })], metricReaders: [] });
sdk.start();
afterAll(() => sdk.shutdown());

it('redacts secrets before both stdout and OTLP export, preserving correlation', async () => {
  const lines: string[] = [];
  const logger = createLogger(new Writable({ write(chunk, _encoding, callback) { lines.push(String(chunk)); callback(); } }));
  requestContext.run({ requestId: 'request-test', tenantId: 'authorized-tenant' }, () => {
    logger.info({ token: 'secret-token', password: 'secret-password', headers: { authorization: 'secret-header' }, body: 'private note' }, 'Safe event');
  });
  await expect.poll(() => records.getFinishedLogRecords().length).toBeGreaterThan(0);
  const line = JSON.parse(lines[0]!);
  expect(line.requestId).toBe('request-test');
  expect(line.tenantId).toBe('authorized-tenant');
  for (const secret of ['secret-token', 'secret-password', 'secret-header', 'private note']) {
    expect(lines.join('')).not.toContain(secret);
    expect(JSON.stringify(records.getFinishedLogRecords())).not.toContain(secret);
  }
  expect(records.getFinishedLogRecords().some((record) => String(record.body).includes('Safe event'))).toBe(true);
});
it('propagates incoming W3C trace context and excludes health checks and query strings', async () => {
  const { createApp } = await import('../app');
  const app = createApp(() => true, (_req, _res, next) => next());
  await request(app).get('/health/live').expect(200);
  const result = await request(app).get('/api/greeting?token=private-query')
    .set('traceparent', '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01').expect(200);
  expect(result.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  await expect.poll(() => spans.getFinishedSpans().length).toBeGreaterThan(0);
  const finished = spans.getFinishedSpans();
  const http = finished.find((span) => span.name === 'GET /greeting');
  expect(http?.spanContext().traceId).toBe('0123456789abcdef0123456789abcdef');
  expect(http?.attributes['http.response.status_code']).toBe(200);
  expect(finished.some((span) => span.name.includes('health'))).toBe(false);
  expect(JSON.stringify(finished.map((span) => ({ name: span.name, attributes: span.attributes, events: span.events })))).not.toContain('private-query');
});
