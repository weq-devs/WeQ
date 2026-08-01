/**
 * Pack `dist/` into the release tarball.
 *
 * Separate from `build-server.mjs` so a normal `pnpm build` doesn't pay the
 * compression cost — only the release workflow calls this.
 *
 * One archive covers every platform: `native/` ships all three platform/arch
 * subtrees and the loader picks the right one at runtime. `node_modules` is
 * shipped pre-installed (see `install-runtime-deps.mjs`) so an offline server
 * can start straight out of the tarball.
 *
 *   node scripts/pack-release.mjs [version]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const dist = join(appRoot, 'dist');
const outDir = join(appRoot, 'release');

const version =
  process.argv[2]?.replace(/^v/, '') ??
  JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version;

for (const entry of [
  'server.mjs',
  'injectWorker.mjs',
  'transcribeWorker.mjs',
  'start.sh',
  'start.bat',
  'public',
  'native',
  'resources',
  'node_modules',
  'package.json',
]) {
  if (existsSync(join(dist, entry))) continue;
  console.error(`dist/${entry} missing — run \`pnpm build && pnpm deps\` first`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const name = `weq-web-${version}.tar.gz`;
const archive = join(outDir, name);

// Notes on the argv shape:
//   -C dist .        unpacks into the current directory, not a nested dist/
//   --exclude first  GNU tar exits 128 if an --exclude trails the path operand
//   -czf -           write to stdout, redirected to the archive by the caller.
//                    Passing a Windows `C:\…` path directly makes GNU tar read
//                    it as rsh host:path syntax and fail.
const fd = openSync(archive, 'w');
const res = spawnSync(
  'tar',
  [
    // Runtime droppings from a local run or the pre-pack smoke test. `logs/`
    // is the native addon's own log dir, which lands in cwd unless WEQ_LOG_DIR
    // says otherwise — belt and braces, since the smoke test now sets it.
    '--exclude=./weq-exports',
    '--exclude=./weq-data',
    '--exclude=./logs',
    '--exclude=./package-lock.json',
    // node_modules IS shipped (pre-installed), but npm's own metadata isn't.
    '--exclude=./node_modules/.package-lock.json',
    '--exclude=./node_modules/.bin',
    '-czf',
    '-',
    '-C',
    dist,
    '.',
  ],
  { stdio: ['ignore', fd, 'inherit'] },
);

if (res.status !== 0) {
  console.error(`tar exited with ${res.status}`);
  process.exit(1);
}

const mb = (statSync(archive).size / 1024 / 1024).toFixed(1);
console.log(`\n  packed → ${archive}  (${mb} MB)\n`);
