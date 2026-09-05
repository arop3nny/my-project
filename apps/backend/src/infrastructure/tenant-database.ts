import { type DataSource, type EntityManager, QueryFailedError } from 'typeorm';
import type { JWTPayload } from 'jose';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { requestContext } from '../observability/context';
const tracer = trace.getTracer('platform-database');
export class AccessDenied extends Error { status = 403; }
export async function withIdentity<T>(database: DataSource, identity: JWTPayload, run: (manager: EntityManager) => Promise<T>, tenantId?: string): Promise<T> {
  if (!identity.iss || !identity.sub) throw new AccessDenied('Verified identity required');
  return tracer.startActiveSpan('postgres.transaction', async (span) => {
    span.setAttribute('db.system.name', 'postgresql');
    try {
      // TypeORM pins this transactional manager to one QueryRunner/pg connection.
      return await database.transaction(async (manager) => {
        await manager.sql`SELECT set_config('app.issuer',${identity.iss},true),set_config('app.subject',${identity.sub},true),set_config('app.tenant_id',${tenantId ?? ''},true)`;
        if (tenantId) {
          const [access] = await manager.sql`SELECT tenancy.authorize(${tenantId}) AS role`;
          if (!access?.role) throw new AccessDenied('Organization membership required');
          const fields = requestContext.getStore();
          if (fields) fields.tenantId = tenantId;
          span.setAttribute('tenant.id', tenantId);
        }
        return run(manager);
      });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error instanceof QueryFailedError ? error.driverError : error;
    } finally { span.end(); }
  });
}
