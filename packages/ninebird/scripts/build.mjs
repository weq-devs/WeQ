/**
 * Bundle the three NineBird loader scripts into `resources/ninebird-runtime/`.
 *
 * The loaders run inside QQ (win32: winhook redirects `loadNineBird.js` reads
 * to `NINEBIRD_LOAD_PATH`; linux: a dropped entry stub `require()`s the path).
 * They are pure JS and platform-independent, so a single build replaces the
 * three per-platform copies that used to live under `native/<platform>/ninebird/`.
 *
 * Output is CJS (QQ evaluates them as CommonJS) with a `{"type":"commonjs"}`
 * marker, mirroring the old `loader/package.json` — the repo root and the web
 * dist both declare `"type":"module"`, so a bare `.js` would otherwise be
 * parsed as ESM and `require` would throw inside QQ.
 */

import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const outDir = join(repoRoot, 'resources', 'ninebird-runtime');

const entries = [
  ['quick-dbkey', 'src/quick-dbkey.ts'],
  ['qr-dbkey', 'src/qr-dbkey.ts'],
  ['account-list', 'src/login-accounts.ts'],
];

mkdirSync(outDir, { recursive: true });

for (const [name, entry] of entries) {
  await build({
    entryPoints: [join(repoRoot, 'packages', 'ninebird', entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    minify: false,
    sourcemap: false,
    outfile: join(outDir, `${name}.js`),
  });
  console.log(`[build:ninebird] ${name}.js -> resources/ninebird-runtime/${name}.js`);
}

// CJS marker: QQ requires these files from a `"type":"module"` tree, so the
// nearest package.json must pin CommonJS semantics for the directory.
writeFileSync(
  join(outDir, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
);
console.log('[build:ninebird] wrote resources/ninebird-runtime/package.json ({"type":"commonjs"})');
