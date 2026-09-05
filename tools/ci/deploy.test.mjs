import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('tools/helm/deploy.sh');

function deploy({ previous = true, smokeFails = false, upgradeFails = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'platform-deploy-test-'));
  const bin = join(directory, 'bin');
  const bundle = join(directory, '.release/bundle');
  mkdirSync(bin);
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'platform-0.1.0.tgz'), 'test chart');
  // Use an isolated fake Helm; no cluster calls or real kubeconfig are involved.
  writeFileSync(join(bin, 'helm'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ args, kubeconfig: process.env.KUBECONFIG }) + '\\n');
if (args[0] === 'history') console.log(JSON.stringify(${JSON.stringify(previous ? [{ revision: 3, status: 'superseded' }, { revision: 5, status: 'deployed' }, { revision: 6, status: 'failed' }] : [])}));
if (args[0] === 'upgrade' && process.env.UPGRADE_FAILS === 'true') process.exit(1);
if (args[0] === 'test' && process.env.SMOKE_FAILS === 'true') process.exit(1);
`, { mode: 0o755 });
  try {
    const result = spawnSync('bash', [script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        KUBE_CONFIG_B64: Buffer.from('test-only-credentials').toString('base64'),
        KUBE_NAMESPACE: 'test-namespace',
        RELEASE_NAME: 'platform',
        DEPLOY_ENVIRONMENT: 'staging',
        GITHUB_STEP_SUMMARY: '',
        CALL_LOG: join(directory, 'calls.jsonl'),
        SMOKE_FAILS: String(smokeFails),
        UPGRADE_FAILS: String(upgradeFails),
      },
    });
    const calls = readFileSync(join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(!existsSync(calls[0].kubeconfig), 'temporary credentials must be removed');
    assert.ok(!`${result.stdout}${result.stderr}`.includes('test-only-credentials'));
    return { status: result.status, calls: calls.map((call) => call.args) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('successful deployment uses atomic upgrades and then runs smoke tests', () => {
  const result = deploy();
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls.map((args) => args[0]), ['history', 'upgrade', 'test']);
  assert.ok(result.calls[1].includes('--atomic'));
  assert.ok(result.calls[1].includes('--reset-values'));
});
test('failed smoke test rolls back to the last deployed revision, not the latest failed one', () => {
  const result = deploy({ smokeFails: true });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls.at(-1).slice(0, 3), ['rollback', 'platform', '5']);
});
test('a failed first-release smoke test uninstalls the failed release', () => {
  const result = deploy({ previous: false, smokeFails: true });
  assert.equal(result.status, 1);
  assert.equal(result.calls.at(-1)[0], 'uninstall');
});
test('failed atomic upgrade fails immediately and never runs smoke tests', () => {
  const result = deploy({ upgradeFails: true });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls.map((args) => args[0]), ['history', 'upgrade']);
});
