import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@acme/contracts': fileURLToPath(new URL('../../libs/contracts/src/index.ts', import.meta.url)) } },
  test: { environment: 'node', include: ['apps/backend/src/**/*.test.ts'] },
});
