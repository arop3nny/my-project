import { readFileSync } from 'node:fs';
import { Kafka, logLevel } from 'kafkajs';
export const queueName = 'platform-jobs-v1';
export const eventTopic = 'platform.events.v1';
export const deadLetterTopic = 'platform.events.dlq.v1';
export const consumerGroup = 'platform-worker-v1';
export function redisOptions(kind: 'QUEUE' | 'CACHE', worker = false) {
  const host = process.env[`${kind}_REDIS_HOST`];
  const password = process.env[`${kind}_REDIS_PASSWORD`];
  if (!host || !password) throw new Error(`${kind} Redis host and password are required`);
  return { host, password, port: Number(process.env[`${kind}_REDIS_PORT`] ?? 6379),
    maxRetriesPerRequest: worker ? null : 1, connectTimeout: 2000,
    ...(worker ? {} : { commandTimeout: 2500, enableOfflineQueue: false }),
  };
}
export function createKafka() {
  const brokers = process.env.KAFKA_BROKERS?.split(',');
  if (!brokers?.length) throw new Error('KAFKA_BROKERS is required');
  const ca = process.env.KAFKA_CA_FILE;
  const username = process.env.KAFKA_USERNAME;
  const password = process.env.KAFKA_PASSWORD;
  if (process.env.NODE_ENV === 'production' && (!ca || !username || !password)) throw new Error('Kafka TLS and SCRAM credentials required');
  return new Kafka({ clientId: 'platform-worker', brokers,
    ssl: ca ? { ca: [readFileSync(ca, 'utf8')], rejectUnauthorized: true } : undefined,
    sasl: username && password ? { mechanism: 'scram-sha-512', username, password } : undefined,
    logLevel: logLevel.NOTHING, connectionTimeout: 3000, requestTimeout: 5000,
    retry: { retries: 3, initialRetryTime: 300 },
  });
}
