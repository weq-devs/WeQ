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
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');

const TOKEN = 'smoke-dist-token';
const PORT = 39955;

let failed = 0;
function check(ok: boolean, label: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

for (const entry of ['server.mjs', 'public/index.html', 'native', 'resources']) {
  if (existsSync(join(dist, entry))) continue;
  console.error(`FAIL  dist/${entry} missing — run \`pnpm build\` first`);
  process.exit(1);
}

// One archive must carry every platform's native bundle.
for (const platform of ['win32/x64', 'linux/x64', 'linux/arm64']) {
  check(existsSync(join(dist, 'native', platform)), `native/${platform} shipped (universal)`);
}

// The bundle keeps native-loading packages external, so a release needs the
// same `npm install` the README tells users to run. Do it here, both to test
// that instruction and because the server won't start without it.
if (!existsSync(join(dist, 'node_modules'))) {
  console.log('installing runtime deps into dist/ (as the README instructs)…');
  const install = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: dist,
    stdio: 'inherit',
    shell: true,
  });
  if (install.status !== 0) {
    console.error('FAIL  npm install in dist/ failed');
    process.exit(1);
  }
}

const server = spawn(process.execPath, [join(dist, 'server.mjs')], {
  cwd: dist,
  env: { ...process.env, WEQ_TOKEN: TOKEN, WEQ_PORT: String(PORT) },
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
