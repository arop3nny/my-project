import { Writable } from 'node:stream';
import pino from 'pino';
import { context, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { requestContext } from './context';

export function createLogger(stdout: NodeJS.WritableStream = process.stdout) {
  // Consume Pino's already-redacted JSON, so OTLP and stdout receive the same safe record.
  const otlp = new Writable({ write(chunk, _encoding, callback) {
    try {
      const record = JSON.parse(String(chunk));
      const severity = record.level >= 50 ? SeverityNumber.ERROR : record.level >= 40 ? SeverityNumber.WARN : SeverityNumber.INFO;
      logs.getLogger('platform').emit({
        body: JSON.stringify(record),
        severityNumber: severity,
        severityText: record.level >= 50 ? 'ERROR' : record.level >= 40 ? 'WARN' : 'INFO',
        timestamp: new Date(record.time),
        attributes: Object.fromEntries(Object.entries(record).filter(([key, value]) => !['msg', 'time', 'level'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value))) as Record<string, string | number | boolean>,
        context: record.trace_id ? trace.setSpanContext(ROOT_CONTEXT, { traceId: record.trace_id, spanId: record.span_id, traceFlags: record.trace_flags ?? 0 }) : context.active(),
      });
      callback();
    } catch { callback(); } // Telemetry must never make a request fail.
  } });
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: process.env.OTEL_SERVICE_NAME ?? 'platform-backend' },
    redact: { paths: ['authorization', 'cookie', 'password', 'token', 'access_token', '*.password', '*.token', 'req', 'res', 'body', 'headers'], censor: '[REDACTED]' },
    mixin() {
      const span = trace.getSpan(context.active())?.spanContext();
      return { ...requestContext.getStore(), ...(span ? { trace_id: span.traceId, span_id: span.spanId, trace_flags: span.traceFlags } : {}) };
    },
  }, pino.multistream([{ stream: stdout }, { stream: otlp }]));
}
export const logger = createLogger();
