import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APPS = ['frontend', 'backend'];
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export function imageRepository(repository, app) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository) || !APPS.includes(app)) throw new Error('Invalid image repository');
  return `ghcr.io/${repository.toLowerCase()}/${app}`;
}

export function validateManifest(manifest, repository) {
  if (manifest?.schemaVersion !== 1 || !COMMIT.test(manifest.commit)) throw new Error('Invalid release manifest');
  for (const app of APPS) {
    const image = manifest.images?.[app];
    if (image?.repository !== imageRepository(repository, app) || !DIGEST.test(image?.digest)) throw new Error(`Invalid ${app} image`);
  }
  return manifest;
}

export function buildManifest({ repository, commit, previous, built, planned }) {
  if (!COMMIT.test(commit)) throw new Error('Expected a full Git commit SHA');
  if (previous) validateManifest(previous, repository);
  const images = {};
  for (const app of APPS) {
    if (planned.includes(app)) {
      // A failed or missing build must never silently use an old image.
      if (!DIGEST.test(built[app])) throw new Error(`Missing valid build digest for ${app}`);
      images[app] = { repository: imageRepository(repository, app), digest: built[app] };
    } else {
      if (!previous?.images[app]) throw new Error(`No previous image for ${app}; a full build is required`);
      images[app] = previous.images[app];
    }
  }
  return validateManifest({ schemaVersion: 1, commit, images }, repository);
}

export function selectBuilds(affected, previous) {
  return previous ? APPS.filter((app) => affected.includes(app)) : [...APPS];
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
    else process.stdout.write(line);
  }
}

function affected(base, head, target) {
  return JSON.parse(run('pnpm', ['exec', 'nx', 'show', 'projects', '--affected', `--base=${base}`, `--head=${head}`, `--withTarget=${target}`, '--json']));
}

function prepare() {
  mkdirSync('.release', { recursive: true });
  const repository = process.env.GITHUB_REPOSITORY;
  const head = process.env.GITHUB_SHA;
  let previous;
  let base = process.env.NX_BASE;
  const isPullRequest = process.env.GITHUB_EVENT_NAME === 'pull_request';

  if (!isPullRequest) {
    try {
      const runs = JSON.parse(run('gh', ['api', `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=10`]));
      const last = runs.workflow_runs.find((item) => String(item.id) !== process.env.GITHUB_RUN_ID);
      if (!last) throw new Error('No previous successful staging release');
      run('gh', ['run', 'download', String(last.id), '--repo', repository, '--name', 'release-bundle', '--dir', '.release/previous']);
      previous = validateManifest(JSON.parse(readFileSync('.release/previous/manifest.json', 'utf8')), repository);
      if (previous.commit !== last.head_sha) throw new Error('Previous manifest does not match its workflow commit');
      base = previous.commit;
      // A rewritten main branch requires a fresh baseline.
      run('git', ['merge-base', '--is-ancestor', base, head]);
    } catch (error) {
      console.warn(`No reusable baseline; building every app. ${error.message}`);
      previous = undefined;
      base = undefined;
    }
  }

  const all = !base;
  const changed = all ? APPS : affected(base, head, 'container');
  const projects = isPullRequest ? changed.filter((app) => APPS.includes(app)) : selectBuilds(changed, previous);
  writeFileSync('.release/plan.json', JSON.stringify({ repository, commit: head, base, all, projects, previous }, null, 2));
  output({ projects, hasImages: projects.length > 0, all, base: base ?? head, head });
}

function bundle() {
  const plan = JSON.parse(readFileSync('.release/plan.json', 'utf8'));
  const built = {};
  for (const app of plan.projects) built[app] = readFileSync(`.release/digests/${app}.txt`, 'utf8').trim();
  const manifest = buildManifest({ ...plan, planned: plan.projects, built });
  mkdirSync('.release/bundle', { recursive: true });
  writeFileSync('.release/bundle/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  // JSON is valid YAML. Helm accepts it without a YAML serialization dependency.
  writeFileSync('.release/bundle/images.yaml', JSON.stringify({
    releaseCommit: manifest.commit,
    frontend: { image: manifest.images.frontend },
    backend: { image: manifest.images.backend },
  }, null, 2) + '\n');
}

function verify() {
  const manifest = validateManifest(JSON.parse(readFileSync('.release/bundle/manifest.json', 'utf8')), process.env.GITHUB_REPOSITORY);
  if (manifest.commit !== process.env.EXPECTED_SHA) throw new Error('Release bundle does not match the successful staging commit');
  const values = JSON.parse(readFileSync('.release/bundle/images.yaml', 'utf8'));
  if (values.releaseCommit !== manifest.commit || APPS.some((app) => JSON.stringify(values[app]?.image) !== JSON.stringify(manifest.images[app]))) {
    throw new Error('Image values do not match the release manifest');
  }
  const charts = readdirSync('.release/bundle').filter((file) => /^platform-.+\.tgz$/.test(file));
  if (charts.length !== 1) throw new Error('Expected exactly one packaged chart');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const commands = { prepare, bundle, verify };
  const command = commands[process.argv[2]];
  if (!command) throw new Error('Usage: node tools/ci/release.mjs prepare|bundle|verify');
  command();
}
