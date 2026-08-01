/**
 * Install the bundle's external runtime deps into `dist/node_modules`.
 *
 * The esbuild bundle keeps `ws` and `@resvg/resvg-js` external (they load
 * `.node` bindings), so the release archive has to carry them pre-installed —
 * a server with no npm registry access, or no network at all, still has to
 * start.
 *
 * The catch is resvg: it picks its binding from an OPTIONAL dependency chosen
 * by the installing machine's platform, but our archive is universal. So we
 * install the host's own set first, then force-add the bindings for every
 * platform we ship. `js-binding.js` requires them by name at runtime, so
 * whichever one matches the running machine resolves and the rest sit unused.
 *
 *   node scripts/install-runtime-deps.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');

/**
 * resvg bindings for every platform/arch the archive claims to support. Kept
 * in sync with `native/` (win32-x64, linux-x64, linux-arm64); the `-gnu`
 * variants cover glibc, which is what the AppImage/tarball target anyway.
 */
const RESVG_BINDINGS = [
  '@resvg/resvg-js-win32-x64-msvc',
  '@resvg/resvg-js-linux-x64-gnu',
  '@resvg/resvg-js-linux-arm64-gnu',
];

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

// `--force` because npm refuses to add a package whose `os`/`cpu` fields don't
// match the host — which is exactly what we're doing on purpose.
npm(
  [
    'install',
    '--no-audit',
    '--no-fund',
    '--force',
    ...RESVG_BINDINGS.map((p) => `${p}@${RESVG_VERSION}`),
  ],
  'installing cross-platform resvg bindings',
);

console.log(`\n  runtime deps installed → ${join(dist, 'node_modules')}\n`);
