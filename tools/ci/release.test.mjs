import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, selectBuilds, validateManifest } from './release.mjs';

const repository = 'Acme/Platform';
const digest = (character) => `sha256:${character.repeat(64)}`;
const previous = {
  schemaVersion: 1,
  commit: 'a'.repeat(40),
  images: {
    frontend: { repository: 'ghcr.io/acme/platform/frontend', digest: digest('a') },
    backend: { repository: 'ghcr.io/acme/platform/backend', digest: digest('b') },
  },
};

test('the first release builds both apps even if Nx reports only one', () => {
  assert.deepEqual(selectBuilds(['frontend'], undefined), ['frontend', 'backend']);
});
test('an existing release only rebuilds affected deployable projects', () => {
  assert.deepEqual(selectBuilds(['contracts', 'frontend'], previous), ['frontend']);
  assert.deepEqual(selectBuilds(['tooling'], previous), []);
});
test('a frontend-only release preserves the exact backend digest', () => {
  const manifest = buildManifest({ repository, commit: 'c'.repeat(40), previous, planned: ['frontend'], built: { frontend: digest('c') } });
  assert.deepEqual(manifest.images.backend, previous.images.backend);
  assert.equal(manifest.images.frontend.digest, digest('c'));
});
test('a chart-only release retains both images', () => {
  const manifest = buildManifest({ repository, commit: 'c'.repeat(40), previous, planned: [], built: {} });
  assert.deepEqual(manifest.images, previous.images);
});
test('a missing affected build fails instead of reusing stale code', () => {
  assert.throws(() => buildManifest({ repository, commit: 'c'.repeat(40), previous, planned: ['backend'], built: {} }), /Missing valid build digest/);
});
test('bootstrap cannot publish a partial release', () => {
  assert.throws(() => buildManifest({ repository, commit: 'c'.repeat(40), planned: ['frontend'], built: { frontend: digest('c') } }), /full build is required/);
});
test('reject mutable tags and image references from another repository', () => {
  const invalid = structuredClone(previous);
  invalid.images.frontend.digest = 'latest';
  assert.throws(() => validateManifest(invalid, repository), /Invalid frontend image/);
  assert.throws(() => validateManifest(previous, 'another/repository'), /Invalid frontend image/);
});
