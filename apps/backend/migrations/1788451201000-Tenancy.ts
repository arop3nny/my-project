import type { MigrationInterface, QueryRunner } from 'typeorm';
export class Tenancy1788451201000 implements MigrationInterface {
  name = 'Tenancy1788451201000';
  async up(queryRunner: QueryRunner): Promise<void> { await queryRunner.query(`
-- platform_runtime is provisioned by CloudNativePG (or tools/database/setup-local.sh).
-- Migrations run as the platform owner; the HTTP server must never use that role.
CREATE SCHEMA tenancy;
CREATE TABLE tenancy.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenancy.memberships (
  organization_id uuid NOT NULL REFERENCES tenancy.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES accounts.profiles(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX memberships_user ON tenancy.memberships(user_id);
CREATE UNIQUE INDEX one_owner_per_organization ON tenancy.memberships(organization_id) WHERE role = 'owner';
CREATE TABLE tenancy.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES tenancy.organizations(id),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL REFERENCES accounts.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_organization ON tenancy.notes(organization_id, created_at DESC);

-- These small, fixed-search-path functions read control tables as their owner.
-- The runtime cannot write control tables directly or replace these functions.
CREATE FUNCTION tenancy.actor_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT id FROM accounts.profiles
  WHERE issuer = current_setting('app.issuer', true) AND subject = current_setting('app.subject', true)
$$;
CREATE FUNCTION tenancy.member_role(org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT role FROM tenancy.memberships WHERE organization_id = org AND user_id = tenancy.actor_id()
$$;

ALTER TABLE accounts.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_profile ON accounts.profiles
  USING (issuer = current_setting('app.issuer', true) AND subject = current_setting('app.subject', true))
  WITH CHECK (issuer = current_setting('app.issuer', true) AND subject = current_setting('app.subject', true));
ALTER TABLE tenancy.organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_organizations ON tenancy.organizations FOR SELECT
  USING (tenancy.member_role(id) IS NOT NULL);
ALTER TABLE tenancy.memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_memberships ON tenancy.memberships FOR SELECT USING (user_id = tenancy.actor_id());
ALTER TABLE tenancy.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_notes ON tenancy.notes
  USING (organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND tenancy.member_role(organization_id) IS NOT NULL)
  WITH CHECK (organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND tenancy.member_role(organization_id) IS NOT NULL AND created_by = tenancy.actor_id());

CREATE FUNCTION tenancy.create_organization(org_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE org uuid; actor uuid := tenancy.actor_id();
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Account required' USING ERRCODE = '42501'; END IF;
  INSERT INTO tenancy.organizations(name) VALUES (btrim(org_name)) RETURNING id INTO org;
  INSERT INTO tenancy.memberships VALUES (org, actor, 'owner');
  RETURN org;
END $$;

CREATE FUNCTION tenancy.list_members(org uuid)
RETURNS TABLE (user_id uuid, display_name text, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF tenancy.member_role(org) IS NULL THEN RAISE EXCEPTION 'Membership required' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT p.id, p.display_name, m.role FROM tenancy.memberships m
    JOIN accounts.profiles p ON p.id = m.user_id WHERE m.organization_id = org ORDER BY p.display_name;
END $$;

CREATE FUNCTION tenancy.set_member(org uuid, member uuid, new_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE actor_role text; old_role text;
BEGIN
  -- Serialize membership changes and tenant writes against the organization lock.
  PERFORM 1 FROM tenancy.organizations WHERE id = org FOR UPDATE;
  actor_role := tenancy.member_role(org);
  SELECT role INTO old_role FROM tenancy.memberships WHERE organization_id = org AND user_id = member;
  IF actor_role IS NULL OR actor_role NOT IN ('owner', 'admin') OR old_role = 'owner'
    OR (new_role IS NOT NULL AND new_role NOT IN ('admin', 'member'))
    OR (actor_role = 'admin' AND (old_role = 'admin' OR new_role = 'admin')) THEN
    RAISE EXCEPTION 'Insufficient permission' USING ERRCODE = '42501';
  END IF;
  IF new_role IS NULL THEN
    DELETE FROM tenancy.memberships WHERE organization_id = org AND user_id = member;
  ELSE
    INSERT INTO tenancy.memberships VALUES (org, member, new_role)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role;
  END IF;
END $$;

-- Hold a shared lock until request transaction completion: membership revocation
-- takes an exclusive lock, so a revoked member cannot race a new tenant write.
CREATE FUNCTION tenancy.authorize(org uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM tenancy.organizations WHERE id = org FOR SHARE;
  RETURN tenancy.member_role(org);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tenancy FROM PUBLIC;
GRANT USAGE ON SCHEMA accounts, tenancy TO platform_runtime;
GRANT SELECT, INSERT ON accounts.profiles TO platform_runtime;
GRANT UPDATE (display_name) ON accounts.profiles TO platform_runtime;
GRANT SELECT ON tenancy.organizations, tenancy.memberships TO platform_runtime;
GRANT SELECT, INSERT, DELETE ON tenancy.notes TO platform_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tenancy TO platform_runtime;
`); }
  async down(queryRunner: QueryRunner): Promise<void> { await queryRunner.query(`
-- Removes organization memberships and notes; global accounts are retained.
DROP TABLE tenancy.notes;
DROP TABLE tenancy.memberships;
DROP TABLE tenancy.organizations;
DROP FUNCTION tenancy.authorize(uuid);
DROP FUNCTION tenancy.set_member(uuid,uuid,text);
DROP FUNCTION tenancy.list_members(uuid);
DROP FUNCTION tenancy.create_organization(text);
DROP POLICY own_profile ON accounts.profiles;
ALTER TABLE accounts.profiles DISABLE ROW LEVEL SECURITY;
DROP FUNCTION tenancy.member_role(uuid);
DROP FUNCTION tenancy.actor_id();
DROP SCHEMA tenancy;
REVOKE ALL ON accounts.profiles FROM platform_runtime;
REVOKE USAGE ON SCHEMA accounts FROM platform_runtime;
`); }
}
