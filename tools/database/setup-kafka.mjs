import { Kafka, logLevel } from 'kafkajs';
const brokers = process.env.KAFKA_BROKERS ?? 'localhost:9092';
if (brokers !== 'localhost:9092') throw new Error('This helper is only for local Kafka');
const admin = new Kafka({ brokers: [brokers], logLevel: logLevel.ERROR }).admin();
try {
  await admin.connect();
  await admin.createTopics({ waitForLeaders: true, topics: ['platform.events.v1', 'platform.events.dlq.v1'].map((topic) => ({ topic, numPartitions: 3, replicationFactor: 1, configEntries: [{ name: 'retention.ms', value: '604800000' }] })) });
  console.log('Local Kafka topics ready');
} finally { await admin.disconnect(); }
