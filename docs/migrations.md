# Database migrations

TypeORM 1.1.1 handles migration execution and history. Migration classes live in `apps/backend/migrations`, with native `up(QueryRunner)` and `down(QueryRunner)` methods. Both API and worker have `synchronize: false` and `migrationsRun: false`. The Helm migration Job uses the same backend image and separate owner credentials.

| Command | Behavior |
| --- | --- |
| `pnpm db:migrate` | Apply all pending migrations. Running again is safe. |
| `pnpm db:rollback` | Revert the latest applied migration using its `down` method. Repeat to go back further. |
| `pnpm db:status` | List applied and pending migrations. |
| `pnpm db:generate apps/backend/migrations/AddFeature` | Generate native up/down SQL from entity changes against the connected database. Review both methods. |
| `pnpm db:create apps/backend/migrations/AddPolicy` | Create an empty native migration for RLS, grants, triggers, functions or data changes. |

Commands load `.env`. Locally, the default owner is `platform`, using `POSTGRES_PASSWORD`; `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD` can override the target. Do not export owner credentials into an API/worker shell. In Kubernetes use owner credentials and the verified cluster CA. Forward and backward commands share the same PostgreSQL advisory lock as Helm. Only migration execution advances TypeORM's `typeorm_migrations` history; TypeORM rolls back failed migration transactions.

Table changes go in entity schemas; generate and review migrations against an up-to-date disposable development database. Authorization functions and PostgreSQL RLS stay explicit in custom native migrations. Existing complex indexes and transport tables are managed in migration SQL. The build discovers and compiles every timestamped migration automatically.

`db:rollback` reverses schema, **not lost data**. The initial async migration's down method drops job intent/results and event receipts; the tenancy down method drops organizations, memberships and notes; the accounts down method drops accounts. Stop API/workers that require those tables before invoking a down migration. Restore a tested backup when data recovery is needed. These commands do not stop Kafka, undo published events, roll back Keycloak, or roll back Helm releases. Do not reuse stale Redis cache/queue state after restoring an older database; clear the disposable cache and reconcile pending jobs from the restored outbox before restarting workers.

For production prefer backward-compatible expand/contract changes and a corrective forward migration. Helm's automatic application rollback leaves committed migrations in place, allowing the prior app version to run against the expanded schema. Database rollback is explicit and never automatic on app rollout failure.

Only native TypeORM migration classes are maintained. Once applied, treat them as immutable; TypeORM identifies them by timestamp/name and does not detect edits to their bodies.

Integration coverage runs native up/down/up, transaction failure, tenant authorization on a disposable PostgreSQL instance.
