import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { '@acme/contracts': fileURLToPath(new URL('../../libs/contracts/src/index.ts', import.meta.url)) } },
  test: { environment: 'node', include: ['apps/backend/src/**/*.async-test.ts'], hookTimeout: 60_000, testTimeout: 60_000 },
});
