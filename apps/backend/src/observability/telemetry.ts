import { randomUUID } from 'node:crypto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';

// Explicit instrumentation works in the esbuild bundle without runtime monkey patches.
// Local development is quiet unless an OTLP endpoint is configured.
const enabled = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) && process.env.OTEL_SDK_DISABLED !== 'true';
const sdk = enabled ? new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME ?? 'platform-backend',
    'service.instance.id': process.env.HOSTNAME ?? randomUUID(),
    'service.version': process.env.RELEASE_COMMIT ?? 'development',
    'deployment.environment.name': process.env.DEPLOYMENT_ENVIRONMENT ?? 'development',
  }),
  traceExporter: new OTLPTraceExporter(),
  metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 })],
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
}) : undefined;
sdk?.start();
export async function shutdownTelemetry() { await sdk?.shutdown(); }
