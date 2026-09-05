import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse, parseAllDocuments } from 'yaml';

function values(path) { return parse(readFileSync(path, 'utf8')); }
function render(chart, environment, extra = []) {
  const folder = chart === 'platform' ? 'environments' : chart;
  return parseAllDocuments(execFileSync('helm', ['template', chart, `deploy/helm/${chart}`, '-f', `deploy/${folder}/${environment}.yaml`, ...extra], { encoding: 'utf8' }))
    .map((document) => document.toJSON()).filter(Boolean);
}

for (const environment of ['staging', 'production']) {
  const app = render('platform', environment);
  const messaging = render('messaging', environment);
  const identity = render('identity', environment, ['--set', 'realm.import=true']);
  const edge = render('edge', environment);
  const data = render('data', environment);
  const observability = render('observability', environment);
  const gateway = edge.find((item) => item.kind === 'Gateway');
  const keycloak = identity.find((item) => item.kind === 'Keycloak');
  const realm = identity.find((item) => item.kind === 'KeycloakRealmImport').spec.realm;
  const client = realm.clients.find((item) => item.clientId === 'platform-web');
  const config = JSON.parse(app.find((item) => item.kind === 'ConfigMap').data['config.json']);
  assert.equal(config.keycloak.url, keycloak.spec.hostname.hostname);
  assert.equal(config.keycloak.realm, realm.realm);
  assert.equal(config.keycloak.clientId, client.clientId);
  const appHost = gateway.spec.listeners.find((listener) => listener.name === 'app-https').hostname;
  const identityHost = gateway.spec.listeners.find((listener) => listener.name === 'identity-https').hostname;
  assert.equal(config.keycloak.url, `https://${identityHost}`);
  assert.deepEqual(client.redirectUris, [`https://${appHost}/`]);
  assert.equal(client.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(client.directAccessGrantsEnabled, false);
  for (const route of [...app, ...identity].filter((item) => item.kind === 'HTTPRoute')) {
    assert.equal(route.spec.parentRefs[0].name, gateway.metadata.name);
    assert.equal(route.spec.parentRefs[0].namespace, `edge-${environment}`);
  }
  const backend = app.find((item) => item.kind === 'Deployment' && item.metadata.name.endsWith('-backend'));
  const env = backend.spec.template.spec.containers[0].env;
  assert.equal(env.find((item) => item.name === 'AUTH_ISSUER').value, `${config.keycloak.url}/realms/${realm.realm}`);
  assert.equal(env.find((item) => item.name === 'PGHOST').value, `${data.find((item) => item.kind === 'Cluster').metadata.name}-rw`);
  assert.equal(env.find((item) => item.name === 'PGPASSWORD').valueFrom.secretKeyRef.name, `${data.find((item) => item.kind === 'Cluster').metadata.name}-runtime`);
  const worker = app.find((item) => item.kind === 'Deployment' && item.metadata.name.endsWith('-worker'));
  const workerContainer = worker.spec.template.spec.containers[0];
  assert.equal(workerContainer.image, backend.spec.template.spec.containers[0].image);
  assert.deepEqual(workerContainer.command, ['node', 'worker.cjs']);
  const workerEnv = workerContainer.env;
  const workerPassword = workerEnv.find((item) => item.name === 'PGPASSWORD').valueFrom.secretKeyRef.name;
  assert.equal(workerPassword, 'platform-db-worker');
  assert.equal(data.find((item) => item.kind === 'Cluster').spec.managed.roles.find((role) => role.name === 'platform_worker').passwordSecret.name, workerPassword);
  const kafka = messaging.find((item) => item.kind === 'Kafka');
  assert.equal(kafka.spec.kafka.listeners[0].tls, true);
  assert.equal(kafka.spec.kafka.listeners[0].authentication.type, 'scram-sha-512');
  assert.equal(messaging.find((item) => item.kind === 'KafkaUser').metadata.name, workerEnv.find((item) => item.name === 'KAFKA_USERNAME').value);
  assert.equal(env.some((item) => item.name === 'QUEUE_REDIS_PASSWORD' || item.name === 'KAFKA_PASSWORD'), false);
  for (const redis of ['queue','cache']) {
    const stateful = messaging.find((item) => item.kind === 'StatefulSet' && item.metadata.name === `platform-${redis}`);
    assert.match(stateful.spec.template.spec.containers[0].args[0], redis === 'queue' ? /noeviction/ : /allkeys-lru/);
  }
  const migration = app.find((item) => item.kind === 'Job');
  assert.equal(migration.spec.template.spec.containers[0].image, backend.spec.template.spec.containers[0].image);
  assert.equal(migration.metadata.annotations['helm.sh/hook'], 'pre-install,pre-upgrade');
  const migrationEnv = migration.spec.template.spec.containers[0].env;
  assert.equal(migrationEnv.find((item) => item.name === 'PGPASSWORD').valueFrom.secretKeyRef.name, 'platform-db-app');
  const database = data.find((item) => item.kind === 'Cluster');
  const runtime = database.spec.managed.roles.find((role) => role.name === 'platform_runtime');
  assert.equal(runtime.superuser, false);
  assert.equal(runtime.bypassrls, false);
  assert.equal(runtime.passwordSecret.name, env.find((item) => item.name === 'PGPASSWORD').valueFrom.secretKeyRef.name);
  assert.equal(env.find((item) => item.name === 'OTEL_EXPORTER_OTLP_ENDPOINT').value, `http://otel-collector.observability-${environment}.svc.cluster.local:4318`);
  assert.equal(observability.filter((item) => item.kind === 'StatefulSet').length, 5);
  assert.equal(observability.some((item) => item.kind === 'HTTPRoute'), false);
  const proxy = edge.find((item) => item.kind === 'EnvoyProxy');
  assert.equal(proxy.spec.telemetry.tracing.provider.backendRefs[0].namespace, `observability-${environment}`);
  const grant = observability.find((item) => item.kind === 'ReferenceGrant');
  assert.equal(grant.spec.from[0].namespace, `edge-${environment}`);
  const collector = parse(observability.find((item) => item.metadata.name === 'observability-config').data['collector.yaml']);
  assert.equal(collector.exporters['otlp_http/loki'].endpoint, 'http://loki:3100/otlp');
  assert.equal(collector.service.pipelines.metrics.exporters[0], 'otlp_http/prometheus');
  assert.equal(keycloak.spec.ingress.enabled, false);
  const environmentValues = values(`deploy/environments/${environment}.yaml`);
  assert.equal(environmentValues.gateway.hostname, appHost);
}
console.log('Cross-release gateway, identity, runtime/migration roles, and telemetry references agree.');
