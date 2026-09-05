import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker, UnrecoverableError, type Job } from 'bullmq';
import { context, propagation, trace, SpanKind, SpanStatusCode, metrics, ROOT_CONTEXT } from '@opentelemetry/api';
import type { DataSource } from 'typeorm';
import { AccessDenied, withIdentity } from './tenant-database';
import { createKafka, redisOptions, queueName, eventTopic, deadLetterTopic, consumerGroup } from './async-config';
import { logger } from '../observability/logger';

const tracer = trace.getTracer('platform-async');
const meter = metrics.getMeter('platform-async');
const processed = meter.createCounter('platform.jobs.processed');
const sent = meter.createCounter('platform.outbox.delivered');
const received = meter.createCounter('platform.events.received');
const pending = meter.createGauge('platform.outbox.pending');
const oldest = meter.createGauge('platform.outbox.oldest_age', { unit: 's' });
type Outbox = { id: string; organization_id: string; actor_id: string; issuer: string; subject: string; destination: 'job' | 'event'; payload: { jobId?: string; runAfter?: string; type?: string; noteId?: string }; trace_context: Record<string, string>; created_at: Date };

export async function processJob(pool: DataSource, job: Job<{ outboxId: string }>) {
  const record = (await pool.query<Outbox[]>("SELECT * FROM messaging.outbox WHERE id=$1 AND destination='job'", [job.data.outboxId]))[0];
  if (!record || record.payload.jobId !== job.id) throw new UnrecoverableError('Invalid job reference');
  const parent = propagation.extract(ROOT_CONTEXT, record.trace_context);
  return context.with(parent, () => tracer.startActiveSpan('job.notes-report', { kind: SpanKind.CONSUMER }, async (span) => {
    span.setAttributes({ 'tenant.id': record.organization_id, 'job.id': job.id!, 'messaging.system': 'redis' });
    try {
      const result = await withIdentity(pool, { iss: record.issuer, sub: record.subject }, async (db) => {
        // Worker has operational access to job metadata; scope its application work explicitly.
        const locked = await db.sql<{ status: string; result: unknown }[]>`SELECT status,result FROM tenancy.jobs WHERE id=${job.id} AND organization_id=${record.organization_id} AND requested_by=tenancy.actor_id() FOR UPDATE`;
        const row = locked[0];
        if (!row) throw new UnrecoverableError('Job not found');
        if (row.status === 'completed') return row.result;
        if (row.status !== 'pending') throw new UnrecoverableError('Job is terminal');
        const report = (await db.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM tenancy.notes`)[0]!;
        const value = { noteCount: Number(report.count), generatedAt: new Date().toISOString() };
        await db.sql`UPDATE tenancy.jobs SET status='completed',result=${JSON.stringify(value)}::jsonb,completed_at=now() WHERE id=${job.id}`;
        return value;
      }, record.organization_id);
      processed.add(1, { result: 'completed', kind: 'notes-report' });
      logger.info({ event: 'job.completed', jobId: job.id, tenantId: record.organization_id }, 'Job completed');
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      const cancelled = error instanceof AccessDenied;
      if (cancelled || error instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await pool.query("UPDATE tenancy.jobs SET status=$2,failure_code=$3,completed_at=now() WHERE id=$1 AND status='pending'", [job.id, cancelled ? 'cancelled' : 'failed', cancelled ? 'membership_revoked' : 'processing_failed']);
        processed.add(1, { result: cancelled ? 'cancelled' : 'failed', kind: 'notes-report' });
      }
      if (cancelled) throw new UnrecoverableError('Membership revoked');
      throw error;
    } finally { span.end(); }
  }));
}

export async function startAsyncWorker(pool: DataSource) {
  // Producer operations are bounded; BullMQ's blocking worker connection retries indefinitely.
  const queue = new Queue(queueName, { connection: redisOptions('QUEUE') });
  queue.on('error', () => logger.warn({ event: 'queue.unavailable' }, 'Queue unavailable'));
  const kafka = createKafka();
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  const consumer = kafka.consumer({ groupId: consumerGroup, allowAutoTopicCreation: false });
  let stopping = false;
  let consumerReady = false;
  let dispatcherHealthy = true;
  let worker: Worker | undefined;
  let loop: Promise<void> | undefined;
  const abort = new AbortController();
  try {
    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({ topic: eventTopic, fromBeginning: true });
    consumer.on(consumer.events.GROUP_JOIN, () => { consumerReady = true; });
    consumer.on(consumer.events.CRASH, () => { consumerReady = false; logger.error({ event: 'kafka.consumer_crashed' }, 'Kafka consumer stopped or restarting'); });
    await consumer.run({ eachMessage: async ({ topic, partition, message }) => {
      let event: { id: string; type: string; organizationId: string; traceContext?: Record<string, string> };
      try {
        event = JSON.parse(message.value?.toString() ?? '');
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!event || !uuid.test(event.id) || !uuid.test(event.organizationId) || event.type !== 'note.created.v1') throw new Error('Invalid event');
      } catch {
        // A poison message is acknowledged only after its dead-letter copy is durable.
        await producer.send({ topic: deadLetterTopic, acks: -1, messages: [{ key: `${topic}:${partition}:${message.offset}`, value: JSON.stringify({ source: { topic, partition, offset: message.offset }, value: message.value?.toString('base64') }) }] });
        received.add(1, { result: 'dead_letter' });
        return;
      }
      const parent = propagation.extract(ROOT_CONTEXT, event.traceContext ?? {});
      await context.with(parent, () => tracer.startActiveSpan('event.note.created', { kind: SpanKind.CONSUMER }, async (span) => {
        try {
          // This starter subscriber records a receipt. Add DB side effects in this SAME transaction.
          const inserted = await pool.query('INSERT INTO messaging.inbox(event_id,event_type,organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id', [event.id, event.type, event.organizationId]);
          received.add(1, { result: inserted.length ? 'processed' : 'duplicate' });
          if (inserted.length) logger.info({ event: 'event.received', eventId: event.id, tenantId: event.organizationId }, 'Event received');
        } catch (error) { span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
        finally { span.end(); }
      }));
    } });
    const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('WORKER_CONCURRENCY must be 1..32');
    worker = new Worker(queueName, (job) => processJob(pool, job), { connection: redisOptions('QUEUE', true), concurrency, maxStalledCount: 2 });
    worker.on('error', () => logger.error({ event: 'worker.error' }, 'Worker connection error'));
    worker.on('failed', (job) => logger.warn({ event: 'job.attempt_failed', jobId: job?.id }, 'Job attempt failed'));
    await worker.waitUntilReady();
    let lastReconcile = 0;
    loop = (async () => {
      while (!stopping) {
        try {
          // Recover pending intents after queue storage loss or exhausted stalled-job recovery.
          if (Date.now() - lastReconcile > 60_000) {
            const candidates = await pool.query<{ id: string; job_id: string }[]>(`SELECT o.id,j.id AS job_id FROM messaging.outbox o JOIN tenancy.jobs j ON j.id=(o.payload->>'jobId')::uuid WHERE o.destination='job' AND o.delivered_at IS NOT NULL AND j.status='pending' ORDER BY o.next_attempt_at LIMIT 100`);
            for (const record of candidates) {
              const queued = await queue.getJob(record.job_id);
              if (!queued) await pool.query('UPDATE messaging.outbox SET delivered_at=NULL,next_attempt_at=now() WHERE id=$1', [record.id]);
              else if (await queued.getState() === 'failed') await pool.query("UPDATE tenancy.jobs SET status='failed',failure_code='queue_failed',completed_at=now() WHERE id=$1 AND status='pending'", [record.job_id]);
              else await pool.query('UPDATE messaging.outbox SET next_attempt_at=now() WHERE id=$1', [record.id]);
            }
            const stats = (await pool.query("SELECT count(*)::int AS count,coalesce(extract(epoch FROM now()-min(created_at)),0)::float AS age FROM messaging.outbox WHERE delivered_at IS NULL"))[0];
            pending.record(stats.count); oldest.record(stats.age);
            lastReconcile = Date.now();
          }
          const client = pool.createQueryRunner();
          await client.connect();
          let delivered = false;
          try {
            await client.query('BEGIN');
            const record: Outbox | undefined = (await client.query('SELECT * FROM messaging.outbox WHERE delivered_at IS NULL AND next_attempt_at<=now() ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1'))[0];
            if (record) {
              try {
                if (record.destination === 'job') {
                  await queue.add('notes-report', { outboxId: record.id }, { jobId: record.payload.jobId,
                    delay: Math.max(0, new Date(record.payload.runAfter!).getTime() - Date.now()),
                    attempts: 5, backoff: { type: 'exponential', delay: 2000 },
                    removeOnComplete: { age: 86400, count: 10000 }, removeOnFail: { age: 604800, count: 10000 } });
                } else {
                  await producer.send({ topic: eventTopic, acks: -1, messages: [{ key: record.organization_id, value: JSON.stringify({ ...record.payload, id: record.id, organizationId: record.organization_id, actorId: record.actor_id, occurredAt: record.created_at.toISOString(), traceContext: record.trace_context }) }] });
                }
                await client.query('UPDATE messaging.outbox SET delivered_at=now(),attempts=attempts+1 WHERE id=$1', [record.id]);
                sent.add(1, { destination: record.destination }); delivered = true;
              } catch {
                await client.query("UPDATE messaging.outbox SET attempts=attempts+1,next_attempt_at=now()+least(300,power(2,least(attempts,8))) * interval '1 second' WHERE id=$1", [record.id]);
                logger.warn({ event: 'outbox.retry', outboxId: record.id, destination: record.destination }, 'Delivery deferred');
              }
            }
            await client.query('COMMIT');
            dispatcherHealthy = true;
          } catch (error) { await client.query('ROLLBACK'); throw error; }
          finally { await client.release(); }
          if (!delivered) await delay(500, undefined, { signal: abort.signal }).catch(() => {});
        } catch (error) {
          const errorType = error instanceof Error ? error.name : 'UnknownError';
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
          dispatcherHealthy = false;
          if (!stopping) { logger.warn({ event: 'outbox.unavailable', errorType, code }, 'Outbox will retry'); await delay(2000, undefined, { signal: abort.signal }).catch(() => {}); }
        }
      }
    })();
  } catch (error) {
    await worker?.close(true);
    await Promise.allSettled([consumer.disconnect(), producer.disconnect(), queue.close()]);
    throw error;
  }
  return {
    ready: () => !stopping && consumerReady && dispatcherHealthy && Boolean(worker?.isRunning()),
    async close() {
      stopping = true; abort.abort();
      await worker!.close(); // Stops fetching and drains active jobs before closing connections.
      await loop;
      await consumer.disconnect();
      await producer.disconnect();
      await queue.close();
    },
  };
}
