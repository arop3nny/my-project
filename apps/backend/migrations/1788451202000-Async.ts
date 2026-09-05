import type { MigrationInterface, QueryRunner } from 'typeorm';
export class Async1788451202000 implements MigrationInterface {
  name = 'Async1788451202000';
  async up(queryRunner: QueryRunner): Promise<void> { await queryRunner.query(`
-- Transport state is private to the worker; tenant-facing jobs retain RLS.
CREATE SCHEMA messaging;
REVOKE ALL ON SCHEMA messaging FROM PUBLIC;
CREATE TABLE tenancy.jobs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES tenancy.organizations(id),
  requested_by uuid NOT NULL REFERENCES accounts.profiles(id),
  kind text NOT NULL CHECK (kind = 'notes-report'),
  delay_seconds integer NOT NULL CHECK (delay_seconds BETWEEN 0 AND 2592000),
  run_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','cancelled')),
  result jsonb,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX jobs_organization ON tenancy.jobs(organization_id, requested_by, created_at DESC);
ALTER TABLE tenancy.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_tenant ON tenancy.jobs TO platform_runtime
 USING (organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid
   AND requested_by = tenancy.actor_id() AND tenancy.member_role(organization_id) IS NOT NULL)
 WITH CHECK (organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid
   AND requested_by = tenancy.actor_id() AND tenancy.member_role(organization_id) IS NOT NULL);
CREATE POLICY jobs_worker ON tenancy.jobs TO platform_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON tenancy.jobs TO platform_runtime;
GRANT SELECT, UPDATE ON tenancy.jobs TO platform_worker;

CREATE TABLE messaging.outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES tenancy.organizations(id),
 actor_id uuid NOT NULL REFERENCES accounts.profiles(id),
 issuer text NOT NULL, subject text NOT NULL,
 destination text NOT NULL CHECK (destination IN ('job','event')),
 payload jsonb NOT NULL,
 trace_context jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 delivered_at timestamptz,
 attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_pending ON messaging.outbox(next_attempt_at) WHERE delivered_at IS NULL;
ALTER TABLE messaging.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_insert ON messaging.outbox FOR INSERT TO platform_runtime WITH CHECK (
 organization_id = nullif(current_setting('app.tenant_id',true),'')::uuid
 AND actor_id = tenancy.actor_id() AND tenancy.member_role(organization_id) IS NOT NULL
 AND issuer = current_setting('app.issuer',true) AND subject = current_setting('app.subject',true));
CREATE POLICY outbox_worker ON messaging.outbox TO platform_worker USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA messaging TO platform_runtime, platform_worker;
GRANT INSERT ON messaging.outbox TO platform_runtime;
GRANT SELECT, UPDATE ON messaging.outbox TO platform_worker;
CREATE TABLE messaging.inbox (
 event_id uuid PRIMARY KEY, event_type text NOT NULL, organization_id uuid NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON messaging.inbox TO platform_worker;

-- Versioned cache keys prevent an in-flight old read refilling a stale cache key.
CREATE TABLE tenancy.note_cache_versions (
 organization_id uuid PRIMARY KEY REFERENCES tenancy.organizations(id), version bigint NOT NULL DEFAULT 1
);
ALTER TABLE tenancy.note_cache_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cache_version_read ON tenancy.note_cache_versions FOR SELECT TO platform_runtime
 USING (organization_id = nullif(current_setting('app.tenant_id',true),'')::uuid AND tenancy.member_role(organization_id) IS NOT NULL);
GRANT SELECT ON tenancy.note_cache_versions TO platform_runtime;
CREATE FUNCTION messaging.bump_note_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
 INSERT INTO tenancy.note_cache_versions(organization_id) VALUES (coalesce(NEW.organization_id, OLD.organization_id))
 ON CONFLICT (organization_id) DO UPDATE SET version = tenancy.note_cache_versions.version + 1;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION messaging.bump_note_version() FROM PUBLIC;
CREATE TRIGGER notes_cache_version AFTER INSERT OR UPDATE OR DELETE ON tenancy.notes FOR EACH ROW EXECUTE FUNCTION messaging.bump_note_version();
`); }
  async down(queryRunner: QueryRunner): Promise<void> { await queryRunner.query(`
-- Removes all queued job intent, reports and event receipts. Stop API/workers first.
DROP TRIGGER notes_cache_version ON tenancy.notes;
DROP FUNCTION messaging.bump_note_version();
DROP TABLE tenancy.note_cache_versions;
DROP TABLE messaging.inbox;
DROP TABLE messaging.outbox;
DROP TABLE tenancy.jobs;
DROP SCHEMA messaging;
`); }
}
