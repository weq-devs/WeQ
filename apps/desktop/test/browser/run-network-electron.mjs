import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(join(root, 'package.json'));
const electron = require('electron');
await mkdir(join(root, '.artifacts'), { recursive: true });
const directory = await mkdtemp(join(root, '.artifacts/network-smoke-'));
try {
  const entry = join(directory, 'main.mjs');
  await build({
    entryPoints: [join(import.meta.dirname, 'network-electron.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['electron'],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [entry], { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Chromium 网络测试退出码 ${code}`)),
    );
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
