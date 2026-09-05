import { Router } from 'express';
import type { DataSource } from 'typeorm';
import { createAccountsRepository } from './repository';
import { createAccountsService } from './service';

// Public module boundary. Other features should import this entry point only.
export function createAccountsModule(pool: DataSource) {
  const router = Router();
  const accounts = createAccountsService(createAccountsRepository(pool));
  router.get('/me', async (_req, res) => {
    // Provision lazily from verified claims; clients cannot select another account.
    res.json(await accounts.currentUser(res.locals.auth));
  });
  return router;
}
