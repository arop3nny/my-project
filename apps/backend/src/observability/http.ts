import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { context, metrics, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { requestContext } from './context';
import { logger } from './logger';

const tracer = trace.getTracer('platform-http');
const meter = metrics.getMeter('platform-http');
const duration = meter.createHistogram('http.server.request.duration', { unit: 's', advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] } });
const requests = meter.createCounter('http.server.requests');
export const observeHttp: RequestHandler = (req, res, next) => {
  if (req.path.startsWith('/health/')) { next(); return; }
  // Never use an untrusted tenant header as authorization or a metric label.
  const requestId = randomUUID();
  res.setHeader('X-Request-ID', requestId);
  const started = performance.now();
  const parent = propagation.extract(ROOT_CONTEXT, req.headers);
  tracer.startActiveSpan('HTTP request', { kind: SpanKind.SERVER }, parent, (span) => {
    const active = context.active();
    requestContext.run({ requestId }, () => {
      const fields = requestContext.getStore()!;
      let finished = false;
      const finish = () => context.with(active, () => requestContext.run(fields, () => {
        if (finished) return;
        finished = true;
        const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
        const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method) ? req.method : '_OTHER';
        const status = res.writableFinished ? res.statusCode : 499;
        const attributes = { 'http.request.method': method, 'http.route': route, 'http.response.status_code': status };
        span.updateName(`${method} ${route}`);
        span.setAttributes(attributes);
        if (fields.tenantId) span.setAttribute('tenant.id', fields.tenantId);
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        const seconds = (performance.now() - started) / 1000;
        duration.record(seconds, attributes);
        requests.add(1, attributes);
        logger.info({ event: 'http.request', method, route, status, durationMs: Math.round(seconds * 1000) }, 'Request completed');
        span.end();
      }));
      res.once('finish', finish);
      res.once('close', finish);
      next();
    });
  });
};
