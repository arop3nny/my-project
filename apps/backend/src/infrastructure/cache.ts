import { Redis } from 'ioredis';
import { metrics } from '@opentelemetry/api';
import { redisOptions } from './async-config';
import { logger } from '../observability/logger';
const reads = metrics.getMeter('platform-async').createCounter('platform.cache.reads');
export function createCache() {
  if (!process.env.CACHE_REDIS_HOST) return undefined;
  const redis = new Redis(redisOptions('CACHE'));
  redis.on('error', () => logger.warn({ event: 'cache.unavailable' }, 'Cache unavailable; using PostgreSQL'));
  return {
    async get<T>(key: string): Promise<T | undefined> {
      try {
        const value = await redis.get(key);
        reads.add(1, { result: value ? 'hit' : 'miss' });
        return value ? JSON.parse(value) as T : undefined;
      } catch { reads.add(1, { result: 'error' }); return undefined; }
    },
    async set(key: string, value: unknown) { try { await redis.set(key, JSON.stringify(value), 'EX', 30); } catch { /* Cache is optional. */ } },
    close() { redis.disconnect(); },
  };
}
export type Cache = ReturnType<typeof createCache>;
