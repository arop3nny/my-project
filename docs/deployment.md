# Deployment and operations

The repository provides five independently managed releases per environment. It does not create a Kubernetes provider, DNS zone, storage driver, or certificate authority.

| Release | Namespace | Owner | Contents |
| --- | --- | --- | --- |
| `edge` | `edge-staging` / `edge-production` | Gateway workflow | EnvoyProxy, Gateway, HTTPS redirect |
| `identity` | `identity-staging` / `identity-production` | Identity workflow | Keycloak CR, identity PostgreSQL CR, auth HTTPRoute |
| `data` | `platform-staging` / `platform-production` | Database workflow | Application PostgreSQL CR |
| `observability` | `observability-staging` / `observability-production` | Observability workflow | OTel collectors, Prometheus, Grafana, Loki, Tempo |
| `platform` | `platform-staging` / `platform-production` | App CI/promotion | Frontend/backend/worker, migration Job, config, app HTTPRoutes |

There is one backend service, with horizontal replicas in production. Feature modules call each other through public entry points inside the process. PostgreSQL clusters are separate ownership boundaries; the backend does not access Keycloak's database.

## 1. Prepare the cluster

Use Kubernetes 1.32+ with versions supported by the pinned operators, at least three schedulable worker nodes, persistent volume provisioning, a NetworkPolicy-capable CNI, and a LoadBalancer implementation. Each environment starts three application PostgreSQL instances, three identity PostgreSQL instances, two Keycloak replicas, and two Envoy proxy replicas, plus app workloads, telemetry storage/collectors and operator overhead. See [observability](observability.md) for the initial single-replica telemetry topology and its capacity requirements. PostgreSQL uses required node anti-affinity; the Keycloak Operator supplies its default topology spreading.

Review `tools/helm/bootstrap-operators.sh` and its pinned versions before running it with an administrator kubeconfig:

```sh
bash tools/helm/bootstrap-operators.sh
```

This creates the environment namespaces and Roles, installs CloudNativePG 1.28.4, installs Keycloak Operator 26.7.3 in each identity namespace, and installs Envoy Gateway 1.9.1 and its Gateway API CRDs. Operator/CRD installation is a separate administrative operation, not a permission granted to application CI. If your cluster already manages compatible Gateway API CRDs, adapt Envoy's install using its provider-managed CRD instructions instead of taking over those CRDs.

Both identity operators use the same version because CRDs are cluster-wide. Upgrades are explicit and should be staged with database backups; do not configure automatic operator upgrades for production without reviewing their migration behavior.

## 2. Configure domains, TLS, storage, and backups

Replace the example domains consistently in:

- `deploy/edge/{staging,production}.yaml`: app/auth hostnames and TLS Secret names.
- `deploy/environments/{staging,production}.yaml`: app gateway hostname and public Keycloak URL.
- `deploy/identity/{staging,production}.yaml`: Keycloak hostname and realm client app origin.

`pnpm helm:check` checks these references against each other. Each environment's TLS Secrets must exist in its **edge namespace**, where the Gateway lives. Certificates must match the listener hostnames. Provision them through your certificate manager or existing certificate process. No TLS Secrets are needed in the Keycloak namespace with this edge-termination configuration.

Set the PostgreSQL storage classes and sizes in `deploy/data/*.yaml` and `deploy/identity/*.yaml`. CloudNativePG generates application credentials and cluster CA Secrets. Application pods use the restricted `platform-db-runtime` Secret; migration Jobs use the owner `platform-db-app` Secret and verify the PostgreSQL server certificate using `platform-db-ca`. Credentials are mounted/referenced, never stored in the image or chart values.

After rotating application database credentials or CA material, roll the backend pods so their environment and connection pool reload those values.

The charts expose `plugins` and `backup` configuration for CloudNativePG. For production, configure WAL archiving, scheduled base backups, retention, and a tested restore procedure using your chosen storage system, typically the Barman Cloud Plugin. These are deliberately not filled with a fictitious storage bucket or credentials. Replicas and the Helm `keep` annotation do not replace backups. See [CloudNativePG backup configuration](https://cloudnative-pg.io/docs/1.28/backup/).

Gateway listeners only accept routes from namespaces carrying the matching `platform.acme.io/environment` label. The bootstrap namespace manifests supply these labels. Keycloak HTTP traffic is restricted to the matching Envoy data-plane pods in `envoy-gateway-system`; forwarded headers must come through that trusted proxy. TLS terminates at Envoy and upstream HTTP stays inside the cluster. Additional internal transport encryption and finer network policies can be added to match your infrastructure requirements.

## 3. Configure GitHub

Push the repository with `main` as the default branch. Enable Actions and grant the repository access to publish its GHCR packages. Package names are `ghcr.io/<owner>/<repo>/frontend` and `.../backend`; deployments use their immutable digests.

Create these GitHub environments, restrict them to `main`, and require reviewers on the production environments where supported by your GitHub plan:

| Environments | Credential identity |
| --- | --- |
| `staging`, `production` | `github-deployer` in the corresponding platform namespace |
| `data-staging`, `data-production` | `data-deployer` in the corresponding platform namespace |
| `identity-staging`, `identity-production` | `identity-deployer` in the corresponding identity namespace |
| `edge-staging`, `edge-production` | `edge-deployer` in the corresponding edge namespace |
| `observability-staging`, `observability-production` | `observability-deployer` in the corresponding observability namespace |

Each environment needs a `KUBE_CONFIG_B64` secret holding a base64-encoded kubeconfig that authenticates non-interactively from the Linux runner. Prepare this kubeconfig using your organization's identity tooling, bind the provided Role to that identity, and rotate expiring credentials. A `ServiceAccount` manifest alone does not create a usable kubeconfig. For an OIDC identity, adjust the RoleBinding subject and add the provider login step; token permissions alone do not configure authentication.

```sh
base64 < /secure/path/staging.kubeconfig | gh secret set KUBE_CONFIG_B64 --env staging
```

The API server must be reachable from the runner. Use an appropriate self-hosted runner for a private cluster. App workflows accept optional `RELEASE_NAME` and `KUBE_NAMESPACE` variables, but changing a namespace also requires updating the database placement, gateway attachments, labels, and credentials consistently. The supplied infrastructure workflows use the namespace conventions above.

If GHCR packages are private, provision a pull credential Secret in each platform namespace and set `imagePullSecrets` in both app environment values. The short-lived Actions `GITHUB_TOKEN` pushes images; it is not a persistent Kubernetes pull credential.

## 4. Bootstrap in dependency order

After the operators, namespaces, certificates, and credentials are ready, create the Grafana admin Secret as described in [observability](observability.md):

```sh
gh workflow run observability.yml --ref main -f environment=staging
gh workflow run edge.yml --ref main -f environment=staging
gh workflow run data.yml --ref main -f environment=staging
gh workflow run identity.yml --ref main -f environment=staging -f bootstrap_realm=true
```

Wait for each workflow to succeed. Edge, application data, and identity creation are separate from app CI. The identity workflow waits for its PostgreSQL cluster and Keycloak to become ready before importing the realm. The data workflow waits for the application PostgreSQL cluster. The data release must provision `platform_runtime` and `platform_worker` before the tenancy migration runs. For an existing installation, upgrade data before the application. Gateway creation requires the TLS Secrets and a LoadBalancer address.

Point the app and auth DNS names at the corresponding Gateway address:

```sh
kubectl get gateway platform-edge -n edge-staging
kubectl get keycloak keycloak -n identity-staging
kubectl get clusters.postgresql.cnpg.io -n platform-staging
kubectl get clusters.postgresql.cnpg.io -n identity-staging
```

The Keycloak Operator creates initial admin credentials in the `keycloak-initial-admin` Secret. Retrieve them through your normal Secret-access process, establish your administrative account/MFA policy, and create users in the `platform` realm. No production admin or user passwords are committed to this repository.

The realm bootstrap imports `platform-web` as a public PKCE client and configures the `platform-api` access-token audience. Redirect and logout URLs are exact app origins with a trailing slash. `KeycloakRealmImport` is **creation-only**: changes do not reconcile an existing realm. Manage subsequent realm/client changes through reviewed Keycloak administration or a dedicated realm-configuration process. The bootstrap workflow deletes the completed import CR after checking `Done`.

Once staging infrastructure is ready, run/re-run the main CI workflow to build and deploy the application. Repeat infrastructure setup for production before its first app promotion.

## 5. Application releases

Main compares against the last successful staging release, including its complete image manifest. If a build or staging deployment fails, the next run includes all accumulated changes. An expired or missing artifact triggers a complete build. Chart/config-only app releases retain existing image digests; they do not require invented replacement tags.

The application Helm chart runs a migration Job before install/upgrade, using the release's backend image. The database cluster, managed runtime/worker roles and owner/runtime/worker Secrets must already exist. TypeORM applies pending native migrations transactionally under an advisory lock. Commit timestamped migration classes with reviewed `up` and `down` methods. The startup process never races migrations across replicas.

Application workloads use health probes, read-only root filesystems, non-root users, dropped capabilities, resource limits, and rolling updates. Backend shutdown drains requests, then closes its PostgreSQL pool. The frontend receives public OIDC configuration through a ConfigMap; changing it restarts the frontend without rebuilding its image.

After a successful staging workflow:

```sh
gh workflow run promote.yml --ref main -f run_id=123456789
```

Promotion checks the selected successful main staging run and deploys its exact chart, image digests, and production values after the configured environment gate. Choosing an older successful run intentionally promotes that older bundle; reviewers should inspect its commit and migration compatibility.

The current image build target is `linux/amd64`. Add an ARM build runner or QEMU and `linux/arm64` for ARM or mixed clusters.

## Recovery and verification boundaries

Application rollout failure uses Helm atomic rollback. The subsequent Helm test checks frontend HTML/runtime config, database-backed readiness, and rejection of anonymous API requests. A failed test restores the previous deployed app revision, or uninstalls a failed first app release. These checks do not exercise external DNS/TLS or a real interactive login. Add a synthetic sign-in and authenticated API check for your deployed domains.

```sh
helm history platform -n platform-production
helm rollback platform <revision> -n platform-production --wait --timeout 5m
```

Rollback restores application manifests and image references, **not committed SQL or Keycloak database migrations**. Keep SQL compatible with the current and previous app versions. Gateway, Keycloak, and PostgreSQL have separate change windows; identity/data workflows do not automatically downgrade database-backed software after a reconciliation failure. Use tested backups and vendor upgrade procedures for those recoveries.

CloudNativePG Cluster resources carry `helm.sh/resource-policy: keep` so uninstalling a chart does not immediately remove them. They become retained resources that require explicit operational management. Do not delete a namespace as a rollback mechanism: it removes resources independently of Helm retention.

Gateway/HTTPRoute and operator resources reconcile asynchronously. Inspect `Programmed`, `Accepted`, `ResolvedRefs`, Keycloak `Ready`, and PostgreSQL `Ready` conditions when troubleshooting; a successful Helm render alone does not prove live routing or failover.

## Primary references

- [Envoy Gateway installation and CRD ownership](https://gateway.envoyproxy.io/docs/tasks/quickstart/)
- [Keycloak Operator installation](https://www.keycloak.org/operator/installation)
- [Keycloak realm import behavior](https://www.keycloak.org/operator/realm-import)
- [CloudNativePG operator installation](https://cloudnative-pg.io/docs/1.28/installation_upgrade/)
- [Helm 3 atomic upgrades](https://docs.helm.sh/docs/v3/helm/helm_upgrade/)

## Tenancy rollout compatibility

Migration `1788451201000-Tenancy.ts` adds organizations, memberships, RLS and restricted runtime grants without moving existing account rows. Existing accounts remain global identities and start with no memberships. There is no implied default organization. Users create or are added to organizations explicitly. The backend now refuses owner credentials: deploy the updated data chart first, then deploy the app with `platform-db-runtime` while keeping migrations on `platform-db-app`. Refer to [multitenancy](multitenancy.md) for role provisioning and security boundaries.

The messaging release must also be ready before deploying the application. Bootstrap installs Strimzi 1.2.0, watching only the two platform namespaces. Configure `deploy/messaging/{staging,production}.yaml`, create GitHub environments `messaging-staging` and `messaging-production` with namespace-scoped `KUBE_CONFIG_B64` for `messaging-deployer`, then run the **Deploy messaging** workflow. It installs independent Redis queue/cache instances and Kafka 4.3.1, and waits for Kafka, its user and topics. Production uses three Kafka nodes on distinct Kubernetes nodes. Kafka and queue storage are retained on release removal; broker upgrades and recovery are separate operational changes.

Worker replicas use the same immutable backend image as the API and migration Job. An affected backend rebuild therefore updates both processes; production promotion preserves that digest. Workers drain jobs for up to 80 seconds within a 90-second pod grace period. Read [async operations](async.md) before sizing, changing retention or enabling heavier jobs.
