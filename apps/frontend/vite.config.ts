import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: {
    '@acme/contracts': fileURLToPath(new URL('../../libs/contracts/src/index.ts', import.meta.url)),
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  } },
  server: {
    port: 4200,
    strictPort: true,
    proxy: { '/api': process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.PORT ?? 3000}` },
  },
  build: { outDir: '../../dist/apps/frontend', emptyOutDir: true },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.tsx'] },
});
