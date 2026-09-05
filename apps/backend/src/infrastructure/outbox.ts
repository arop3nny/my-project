import { context, propagation } from '@opentelemetry/api';
import type { EntityManager } from 'typeorm';
export async function enqueue(db: EntityManager, organizationId: string, destination: 'job' | 'event', payload: Record<string, unknown>) {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  await db.sql`INSERT INTO messaging.outbox(organization_id,actor_id,issuer,subject,destination,payload,trace_context)
    VALUES (${organizationId},tenancy.actor_id(),current_setting('app.issuer'),current_setting('app.subject'),${destination},${JSON.stringify(payload)}::jsonb,${JSON.stringify(carrier)}::jsonb)`;
}
