/**
 * Smoke-test the packaged server: boot `dist/server.mjs` exactly as a user
 * would and walk the auth flow end to end.
 *
 * This covers what unit tests can't — that the esbuild bundle actually starts
 * under plain Node (CJS interop, native module resolution, `native/` layout),
 * which broke three separate times while building the packaging step.
 *
 * Requires `pnpm build` first. Run: npx tsx apps/web/scripts/smoke-dist.ts
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');

/** Scratch dir for the run's logs/exports, so dist/ stays exactly as built. */
const smokeScratch = mkdtempSync(join(tmpdir(), 'weq-smoke-'));

const TOKEN = 'smoke-dist-token';
const PORT = 39955;

let failed = 0;
function check(ok: boolean, label: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

for (const entry of [
  'server.mjs',
  'injectWorker.mjs',
  'transcribeWorker.mjs',
  'start.sh',
  'start.bat',
  'public/index.html',
  'native',
  'resources',
]) {
  if (existsSync(join(dist, entry))) continue;
  console.error(`FAIL  dist/${entry} missing — run \`pnpm build\` first`);
  process.exit(1);
}

// One archive must carry every platform's native bundle.
for (const platform of ['win32/x64', 'linux/x64', 'linux/arm64']) {
  check(existsSync(join(dist, 'native', platform)), `native/${platform} shipped (universal)`);
}

// The release ships node_modules pre-installed. If a local build skipped that
// step, run it here — the server won't start without it.
if (!existsSync(join(dist, 'node_modules'))) {
  console.log('installing runtime deps into dist/…');
  const install = spawnSync(process.execPath, [join(here, 'install-runtime-deps.mjs')], {
    stdio: 'inherit',
  });
  if (install.status !== 0) {
    console.error('FAIL  runtime dep install failed');
    process.exit(1);
  }
}

// resvg picks its binding by platform at require() time, so the universal
// archive has to carry one per platform we claim to support.
for (const binding of [
  '@resvg/resvg-js-win32-x64-msvc',
  '@resvg/resvg-js-linux-x64-gnu',
  '@resvg/resvg-js-linux-arm64-gnu',
]) {
  check(existsSync(join(dist, 'node_modules', binding)), `${binding} shipped (universal)`);
}

const server = spawn(process.execPath, [join(dist, 'server.mjs')], {
  cwd: dist,
  env: {
    ...process.env,
    WEQ_TOKEN: TOKEN,
    WEQ_PORT: String(PORT),
    // Keep the run's droppings out of dist/, which is about to be tarballed.
    WEQ_DATA_DIR: join(smokeScratch, 'weq-data'),
    WEQ_EXPORT_DIR: join(smokeScratch, 'weq-exports'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
server.stderr.on('data', (c: Buffer) => {
  stderr += c.toString();
});

const base = `http://127.0.0.1:${PORT}`;

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (server.exitCode !== null) return false;
    try {
      await fetch(base, { headers: { accept: 'text/html' } });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

try {
  const up = await waitForServer();
  check(up, 'packaged server boots under plain Node');
  if (!up) {
    console.error(`\nserver output:\n${stderr}`);
    process.exit(1);
  }

  // Pre-auth: closed, but a browser navigation gets the login form.
  const guarded = await fetch(`${base}/trpc/bootstrap.getVersionInfo`);
  check(guarded.status === 401, 'pre-auth tRPC → 401');

  const loginHtml = await (await fetch(base, { headers: { accept: 'text/html' } })).text();
  check(loginHtml.includes('访问令牌'), 'pre-auth navigation → login page');
  check(!loginHtml.includes('/assets/'), 'login page ships no app bundle');

  check(
    (
      await fetch(`${base}/_auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'wrong' }),
      })
    ).status === 401,
    'wrong token → 401',
  );

  const login = await fetch(`${base}/_auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  check(login.status === 200, 'correct token → 200');
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  // Post-auth: a real procedure round-trips, and the SPA + assets are served.
  const version = await (
    await fetch(`${base}/trpc/bootstrap.getVersionInfo`, { headers: { cookie } })
  ).json();
  check(
    typeof version?.result?.data?.json?.node === 'string',
    'post-auth tRPC procedure returns data',
  );

  const shell = await (await fetch(base, { headers: { accept: 'text/html', cookie } })).text();
  check(shell.includes('/assets/'), 'post-auth → SPA shell');

  const asset = await fetch(`${base}/_asset/brand/logo.png`, { headers: { cookie } });
  check(
    asset.status === 200 && (asset.headers.get('content-type') ?? '').startsWith('image/'),
    'weq-asset:// handler serves over /_asset/',
  );

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
} finally {
  server.kill();
}

process.exit(failed === 0 ? 0 : 1);
