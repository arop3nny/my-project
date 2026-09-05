# Organization tenancy

One Keycloak realm authenticates people. The application owns organizations and explicit memberships in its shared PostgreSQL database. A Keycloak realm role, an email domain, or an `X-Tenant-ID` header alone never grants organization access. Accounts are keyed by verified issuer and subject, not email or display name.

The frontend provisions the current account through `GET /api/me`, lists memberships, supports creating/switching organizations, and shows organization notes and member management. Account IDs can be shared with an administrator to add an existing registered user. There is no open join-by-ID endpoint or email invitation workflow.

| Role | Permissions |
| --- | --- |
| Member | Read members; read, create and delete shared organization notes |
| Admin | Member permissions; add/remove regular members |
| Owner | Admin permissions; assign/remove administrators |

The creator becomes the organization's single owner. Owners cannot be removed or demoted through these endpoints. Owner transfer, organization deletion, invitations, billing and per-tenant quotas are separate product features. Admins cannot promote themselves or others to admin/owner. A user may belong to multiple organizations with different roles.

## API

All endpoints require a valid Keycloak access token. Call `/api/me` first to register a new account. Tenant endpoints additionally require `X-Tenant-ID: <organization UUID>`.

| Endpoint | Result |
| --- | --- |
| `GET /api/organizations` | Only the caller's organizations and roles |
| `POST /api/organizations` with `{ "name": "Team" }` | Creates organization and owner membership atomically |
| `GET /api/organization/members` | Current organization's members |
| `PUT /api/organization/members/:userId` with `{ "role": "member" }` or `admin` | Permission-checked membership change |
| `DELETE /api/organization/members/:userId` | Removes an authorized non-owner membership |
| `GET /api/organization/notes` | Latest 100 organization notes |
| `POST /api/organization/notes` with `{ "body": "Text" }` | Creates a tenant-owned note |
| `DELETE /api/organization/notes/:noteId` | Deletes a visible organization note; otherwise 404 |

Missing/malformed tenant IDs return 400; nonmembers and insufficient permissions return 403. Valid authentication without membership returns no tenant data. Membership changes apply to subsequent requests using the same access token; users do not need to sign in again. The UI clears organization state and aborts old reads on switching, and all privileged operations are rechecked server-side even if the UI has a stale role.

## Database boundary

The migration owner `platform` owns schemas and functions. The HTTP server uses `platform_runtime`, a separate login role with no superuser, ownership, role creation, or BYPASSRLS rights. Startup refuses an owner/superuser/BYPASSRLS connection. CloudNativePG manages this runtime role using `platform-db-runtime`; the data chart creates a random password once unless `runtime.existingSecret` names an externally managed basic-auth Secret. App `database.credentialsSecret` must reference that same Secret. Migrations continue using the operator's `platform-db-app` owner Secret.

For local development, set both PostgreSQL passwords in `.env`, then run `pnpm db:setup` before migrations. This configures the restricted login against the local Compose database. Avoid setting `PGUSER=platform` globally when starting the backend; owner credentials are for migrations and disposable tests only.

`withIdentity` acquires one `pg` connection, begins a TypeORM transaction, and uses parameterized `set_config(..., true)` for verified issuer/subject and selected tenant. Context is cleared at commit/rollback before the connection returns to the pool. The callback receives the typed TypeORM transaction; never create a pool-backed TypeORM client inside a tenant request. TypeORM query logging is disabled to avoid recording parameters, and wrapped PostgreSQL errors retain their SQLSTATE for permission handling.

RLS protects accounts, organization visibility, membership visibility and notes. Notes use **FORCE ROW LEVEL SECURITY**, requiring both the selected organization and a live membership; a missing SQL tenant predicate still cannot expose another organization's rows. Tenant note inserts must also identify the current account as creator. The runtime cannot alter schemas, functions, policies or control-table memberships directly.

Small `SECURITY DEFINER` functions perform control-table lookups and membership mutations using a fixed `pg_catalog` search path and fully qualified names. Their owning role deliberately bypasses control-table RLS to avoid recursive membership policies; only the explicitly checked entry points are executable by the runtime. PUBLIC execution is revoked. No HTTP-supplied SQL is accepted. These are authorization primitives and should receive security review when modified.

Organization requests hold a shared organization lock for their transaction. Membership changes take an exclusive lock, so revocation waits for already-authorized operations to finish and blocks later operations from using the revoked membership. Do not hold tenant transactions open while calling external services.

The database trusts identity values set by the backend after JWT verification. RLS guards against missing predicates and unauthorized requests; it does not make a stolen runtime database credential safe. Keep database credentials and direct database access restricted.

## Adding a tenant-owned feature

Add an organization foreign key, useful tenant-prefixed indexes, and RLS policies to every tenant-owned table in a new migration. Grant only necessary table privileges to `platform_runtime`. Update the typed table mapping in `apps/backend/src/infrastructure/schema.ts` alongside the SQL migration. Execute TypeORM queries through the transaction supplied by `withIdentity` with the selected tenant; use composite tenant keys where cross-table relationships must remain inside one organization. Include real-database tests for forged tenant IDs, missing query predicates, cross-tenant writes and revoked memberships. Keep tenant identifiers out of Prometheus labels.

Integration tests use separate generated migration-owner and runtime login roles against a disposable database. They cover raw SQL isolation, API authorization, concurrent pooled requests, role escalation, owner protection, and revocation. They require a disposable PostgreSQL administrator allowed to create databases and roles and clean up only their own generated database/roles.

See [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) and [CloudNativePG role management](https://cloudnative-pg.io/docs/1.28/declarative_role_management/).

Workers connect as `platform_worker`, which inherits runtime permissions and additionally manages job status, the private outbox and Kafka receipts. This is a trusted operational role across tenants; it is never used by the HTTP API. Job payloads contain only a job/outbox reference. The worker loads the stored requester identity, enters `withIdentity`, rechecks live membership and scopes the job to that requester. Queueing never stores an access token. Cache hits also occur inside an authorized transaction; cached note content cannot grant membership.
