import express from 'express';
import { observeHttp } from './observability/http';
import { logger } from './observability/logger';
import helmet from 'helmet';
import type { HealthResponse } from '@acme/contracts';
import { readAuthConfig, requireAuth } from './auth';
import { createPlatformModule } from './modules/platform';

export function createApp(isReady: () => boolean | Promise<boolean> = () => true, authenticate = requireAuth(readAuthConfig()), modules: express.Router[] = []) {
  const app = express();
  app.disable('x-powered-by');
  app.use(observeHttp);
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' } satisfies HealthResponse);
  });
  app.get('/health/ready', async (_req, res) => {
    const ready = await isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable' } satisfies HealthResponse);
  });
  app.use('/api', authenticate, createPlatformModule(), ...modules);
  app.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: 'Invalid request' });
      return;
    }
    logger.error({ event: 'http.error', errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
