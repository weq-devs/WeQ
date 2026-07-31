/**
 * Guard: the browser bundle must contain no Electron-only artifacts.
 *
 * A stray `weq-media://` URL doesn't fail the build — it fails silently at
 * runtime as a broken image, which is easy to miss and tedious to trace. This
 * greps the built assets for anything that only works inside Electron.
 *
 * (Written after a hand-audit missed a second `weq-avatar://` builder that had
 * been duplicated across two files.)
 *
 * Run after `vite build`: npx tsx apps/web/scripts/check-bundle.ts
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, '../dist/public/assets');

/** Substrings that must never appear in a browser bundle. */
const FORBIDDEN = [
  { needle: 'weq-media://', why: 'custom scheme — should be /_media/' },
  { needle: 'weq-avatar://', why: 'custom scheme — should be /_avatar/' },
  { needle: 'weq-asset://', why: 'custom scheme — should be /_asset/' },
  { needle: 'electron-trpc', why: 'Electron IPC transport' },
  { needle: 'require("electron")', why: 'Electron require' },
];

if (!existsSync(DIST)) {
  console.error(`FAIL  no build found at ${DIST} — run \`pnpm --filter @weq/web build\` first`);
  process.exit(1);
}

const files = readdirSync(DIST).filter((f) => f.endsWith('.js'));
if (files.length === 0) {
  console.error('FAIL  build produced no JS assets');
  process.exit(1);
}

let bad = 0;
for (const file of files) {
  const source = readFileSync(join(DIST, file), 'utf8');
  for (const { needle, why } of FORBIDDEN) {
    if (!source.includes(needle)) continue;
    bad++;
    // Show a little context so the offending call site is findable.
    const at = source.indexOf(needle);
    const snippet = source.slice(Math.max(0, at - 70), at + needle.length + 30);
    console.error(`FAIL  ${file}: found "${needle}" (${why})\n      …${snippet}…\n`);
  }
}

if (bad > 0) {
  console.error(`${bad} Electron-only artifact(s) leaked into the web bundle.`);
  process.exit(1);
}

console.log(`PASS  ${files.length} bundle assets are free of Electron-only artifacts`);
