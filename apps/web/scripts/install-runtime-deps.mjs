/**
 * Install the bundle's external runtime deps into `dist/node_modules`.
 *
 * The esbuild bundle keeps `ws` and `@resvg/resvg-js` external (they load
 * `.node` bindings), so the release archive has to carry them pre-installed —
 * a server with no npm registry access, or no network at all, still has to
 * start.
 *
 * resvg picks its binding from an OPTIONAL dependency chosen by the installing
 * machine's platform. Each release archive is single-platform now (built on
 * that platform's own runner), so only the matching binding is added.
 *
 *   node scripts/install-runtime-deps.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTarget, RESVG_BINDINGS } from './platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');

const RESVG_VERSION = '2.6.2';

if (!existsSync(join(dist, 'package.json'))) {
  console.error('dist/package.json missing — run `pnpm build` first');
  process.exit(1);
}

function npm(args, label) {
  const res = spawnSync('npm', args, { cwd: dist, stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    console.error(`\n${label} failed (npm exited ${res.status})`);
    process.exit(1);
  }
}

npm(['install', '--omit=dev', '--no-audit', '--no-fund'], 'installing runtime deps');

const target = currentTarget();
const binding = RESVG_BINDINGS[target];

// `--force` because npm refuses to add a package whose `os`/`cpu` fields don't
// match the host — guaranteed to match here, kept for determinism.
npm(
  ['install', '--no-audit', '--no-fund', '--force', `${binding}@${RESVG_VERSION}`],
  `installing resvg binding for ${target}`,
);

console.log(`\n  runtime deps installed → ${join(dist, 'node_modules')} (${target})\n`);
