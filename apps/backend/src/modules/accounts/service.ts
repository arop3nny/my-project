import type { JWTPayload } from 'jose';
import type { createAccountsRepository } from './repository';

export function createAccountsService(repository: ReturnType<typeof createAccountsRepository>) {
  return {
    currentUser(identity: JWTPayload) {
      if (!identity.iss || !identity.sub) throw new Error('Verified identity is required');
      const name = typeof identity.preferred_username === 'string' ? identity.preferred_username : identity.sub;
      return repository.provision(identity.iss, identity.sub, name);
    },
  };
}
