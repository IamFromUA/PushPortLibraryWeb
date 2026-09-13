import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';

const archive = resolve(process.argv[2] ?? 'pushport-web-sdk-0.0.1.tgz');
const directory = mkdtempSync(join(tmpdir(), 'pushport-consumer-'));
const run = (binary, args) => execFileSync(binary, args, { cwd: directory, stdio: 'inherit' });
const installArgs = ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive, 'typescript@5.9.3'];
try {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  if (process.platform === 'win32') run(process.execPath, [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...installArgs]);
  else run('npm', installArgs);
  writeFileSync(join(directory, 'consumer.mjs'), `
    import { PushPort } from '@pushport/web-sdk';
    import { createRequire } from 'node:module';
    import { existsSync } from 'node:fs';
    const require = createRequire(import.meta.url);
    if (PushPort.isSupported() !== false) throw new Error('SSR feature detection failed');
    if (typeof require('@pushport/web-sdk').PushPort !== 'function') throw new Error('CommonJS export missing');
    if (!existsSync(require.resolve('@pushport/web-sdk/service-worker'))) throw new Error('Worker missing');
  `);
  run(process.execPath, ['consumer.mjs']);
  writeFileSync(join(directory, 'consumer.ts'), `
    import { PushPort, type PushPortOptions, type PushPortStatus } from '@pushport/web-sdk';
    const options: PushPortOptions = { appId: '00000000-0000-4000-8000-000000000001' };
    const initialize = () => PushPort.initialize(options);
    const read = async (): Promise<PushPortStatus> => (await initialize()).status();
    void read;
  `);
  run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', 'consumer.ts']);
} finally {
  // Only the temporary directory created by this invocation is removed.
  const inside = relative(resolve(tmpdir()), resolve(directory));
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Unexpected temporary path');
  rmSync(directory, { recursive: true, force: true });
}
