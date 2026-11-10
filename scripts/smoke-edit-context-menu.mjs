import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
const require = createRequire(join(desktop, 'package.json'));
const artifacts = join(desktop, '.artifacts');
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(artifacts, 'edit-context-menu-'));
try {
  const entry = join(temporary, 'main.mjs');
  await build({
    entryPoints: [join(desktop, 'test/electron/edit_context_menu.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['electron'],
  });
  const env = { ...process.env, WEQ_EDIT_MENU_PROFILE: join(temporary, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [entry], { env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
