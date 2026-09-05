import type { DataSource } from 'typeorm';
import { withIdentity } from '../../infrastructure/tenant-database';
import { ProfileEntity } from '../../infrastructure/schema';
import type { CurrentUserResponse } from '@acme/contracts';
export function createAccountsRepository(database: DataSource) {
  return {
    async provision(issuer: string, subject: string, displayName: string): Promise<CurrentUserResponse> {
      return withIdentity(database, { iss: issuer, sub: subject }, async (manager) => {
        // One statement returns the existing identity without a read/write race.
        const result = await manager.createQueryBuilder().insert().into(ProfileEntity).values({ issuer, subject, displayName })
          .orUpdate(['display_name'], ['issuer','subject']).returning(['id','displayName','createdAt']).execute();
        const row = result.raw[0];
        return { id: row.id, displayName: row.display_name, joinedAt: row.created_at.toISOString() };
      });
    },
  };
}
