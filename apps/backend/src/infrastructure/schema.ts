import { EntitySchema } from 'typeorm';

export interface Profile { id: string; issuer: string; subject: string; displayName: string; createdAt: Date }
export interface Organization { id: string; name: string; createdAt: Date }
export interface Membership { organizationId: string; userId: string; role: 'owner' | 'admin' | 'member' }
export interface Note { id: string; organizationId: string; body: string; createdBy: string; createdAt: Date }
export interface BackgroundJob { id: string; organizationId: string; requestedBy: string; kind: 'notes-report'; delaySeconds: number; runAfter: Date; status: 'pending' | 'completed' | 'failed' | 'cancelled'; result: { noteCount: number; generatedAt: string } | null; failureCode: string | null; createdAt: Date; completedAt: Date | null }

const id = { type: 'uuid', primary: true, generated: 'uuid' } as const;
const createdAt = { name: 'created_at', type: 'timestamptz', default: () => 'now()' } as const;
export const ProfileEntity = new EntitySchema<Profile>({ name: 'Profile', schema: 'accounts', tableName: 'profiles', columns: {
  id, issuer: { type: 'text' }, subject: { type: 'text' }, displayName: { name: 'display_name', type: 'text' }, createdAt,
}, uniques: [{ name: 'profiles_issuer_subject_key', columns: ['issuer','subject'] }] });
export const OrganizationEntity = new EntitySchema<Organization>({ name: 'Organization', schema: 'tenancy', tableName: 'organizations', columns: { id, name: { type: 'text' }, createdAt }, checks: [{ name: 'organizations_name_check', expression: 'length(btrim(name)) BETWEEN 1 AND 100' }] });
export const MembershipEntity = new EntitySchema<Membership>({ name: 'Membership', schema: 'tenancy', tableName: 'memberships', columns: {
  organizationId: { name: 'organization_id', type: 'uuid', primary: true, primaryKeyConstraintName: 'memberships_pkey' },
  userId: { name: 'user_id', type: 'uuid', primary: true, primaryKeyConstraintName: 'memberships_pkey' }, role: { type: 'text' },
}, foreignKeys: [
  { name: 'memberships_organization_id_fkey', target: OrganizationEntity, columnNames: ['organizationId'], referencedColumnNames: ['id'], onDelete: 'CASCADE' },
  { name: 'memberships_user_id_fkey', target: ProfileEntity, columnNames: ['userId'], referencedColumnNames: ['id'] },
], indices: [{ name: 'memberships_user', columns: ['userId'] }, { name: 'one_owner_per_organization', columns: ['organizationId'], unique: true, where: "role = 'owner'" }], checks: [{ name: 'memberships_role_check', expression: "role IN ('owner','admin','member')" }] });
export const NoteEntity = new EntitySchema<Note>({ name: 'Note', schema: 'tenancy', tableName: 'notes', columns: {
  id, organizationId: { name: 'organization_id', type: 'uuid' }, body: { type: 'text' }, createdBy: { name: 'created_by', type: 'uuid' }, createdAt,
}, foreignKeys: [
  { name: 'notes_organization_id_fkey', target: OrganizationEntity, columnNames: ['organizationId'], referencedColumnNames: ['id'] },
  { name: 'notes_created_by_fkey', target: ProfileEntity, columnNames: ['createdBy'], referencedColumnNames: ['id'] },
], indices: [{ name: 'notes_organization', synchronize: false }], checks: [{ name: 'notes_body_check', expression: 'length(btrim(body)) BETWEEN 1 AND 2000' }] });
export const JobEntity = new EntitySchema<BackgroundJob>({ name: 'BackgroundJob', schema: 'tenancy', tableName: 'jobs', columns: {
  id: { type: 'uuid', primary: true }, organizationId: { name: 'organization_id', type: 'uuid' }, requestedBy: { name: 'requested_by', type: 'uuid' }, kind: { type: 'text' },
  delaySeconds: { name: 'delay_seconds', type: 'integer' }, runAfter: { name: 'run_after', type: 'timestamptz' }, status: { type: 'text', default: 'pending' },
  result: { type: 'jsonb', nullable: true }, failureCode: { name: 'failure_code', type: 'text', nullable: true }, createdAt,
  completedAt: { name: 'completed_at', type: 'timestamptz', nullable: true },
}, foreignKeys: [
  { name: 'jobs_organization_id_fkey', target: OrganizationEntity, columnNames: ['organizationId'], referencedColumnNames: ['id'] },
  { name: 'jobs_requested_by_fkey', target: ProfileEntity, columnNames: ['requestedBy'], referencedColumnNames: ['id'] },
], indices: [{ name: 'jobs_organization', synchronize: false }], checks: [
  { name: 'jobs_kind_check', expression: "kind = 'notes-report'" },
  { name: 'jobs_delay_seconds_check', expression: 'delay_seconds BETWEEN 0 AND 2592000' },
  { name: 'jobs_status_check', expression: "status IN ('pending','completed','failed','cancelled')" },
] });
// Transport tables, cache counters and security functions are migration-owned SQL.
export const entities = [ProfileEntity, OrganizationEntity, MembershipEntity, NoteEntity, JobEntity];
