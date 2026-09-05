import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';

await build({
  entryPoints: ['apps/backend/src/main.ts', 'apps/backend/src/migrate.ts', 'apps/backend/src/worker.ts'],
  outdir: 'dist/apps/backend',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  external: ['typeorm', 'pg', 'reflect-metadata'],
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  tsconfig: 'tsconfig.base.json',
});
await mkdir('dist/apps/backend/migrations', { recursive: true });
await build({
  entryPoints: (await readdir('apps/backend/migrations')).filter((name) => name.endsWith('.ts')).map((name) => `apps/backend/migrations/${name}`),
  outdir: 'dist/apps/backend/migrations', outExtension: { '.js': '.cjs' },
  bundle: true, packages: 'external', platform: 'node', target: 'node22', format: 'cjs',
});
