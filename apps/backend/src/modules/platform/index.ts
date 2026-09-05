import { Router } from 'express';
import type { GreetingResponse } from '@acme/contracts';

export function createPlatformModule() {
  const router = Router();
  router.get('/greeting', (_req, res) => {
    res.json({ message: 'Your frontend and backend are connected.', service: 'backend' } satisfies GreetingResponse);
  });
  return router;
}
