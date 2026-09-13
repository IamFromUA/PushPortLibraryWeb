import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
const common = { bundle: true, target: 'es2022', sourcemap: true, legalComments: 'eof' };
await Promise.all([
  build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.js', format: 'esm' }),
  build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.cjs', format: 'cjs' }),
  build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/pushport.js', format: 'iife', globalName: 'PushPortWeb' }),
  build({ ...common, entryPoints: ['src/worker.ts'], outfile: 'dist/pushport-sw.js', format: 'iife' }),
]);
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
