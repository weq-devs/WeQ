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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTarget, RESVG_BINDINGS } from './platform.mjs';
import { validateRuntimeMetadata, readRuntimeSource } from './runtime-deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.WEQ_WEB_DIST ?? resolve(here, '../dist'));

const TOKEN = 'smoke-dist-token';

let failed = 0;
function check(ok: boolean, label: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

for (const entry of [
  'server.mjs',
  'attachWorker.mjs',
  'backupProbeWorker.mjs',
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

// Every platform/arch gets its own archive, built on its own runner. This run
// only has to prove the packaging target's artifacts are present.
const target = currentTarget();
const runtimeSource = readRuntimeSource(resolve(here, '../../..'));
const [platform, arch] = target.split('-');
check(existsSync(join(dist, 'native', platform!, arch!)), `native/${platform}/${arch} shipped`);

check(!existsSync(join(dist, 'resources', 'daemon')), 'no independent daemon shipped');

// The release ships node_modules pre-installed. If a local build skipped that
// step, run it here — the server won't start without it.
let runtimeReady = false;
if (existsSync(join(dist, 'node_modules'))) {
  try {
    runtimeReady = validateRuntimeMetadata(dist, runtimeSource).target === target;
  } catch {
    /* 旧构建需离线重建依赖。 */
  }
}
if (!runtimeReady) {
  console.log('installing runtime deps into dist/…');
  const install = spawnSync(process.execPath, [join(here, 'install-runtime-deps.mjs')], {
    stdio: 'inherit',
  });
  if (install.status !== 0) {
    console.error('FAIL  runtime dep install failed');
    process.exit(1);
  }
}
check(
  validateRuntimeMetadata(dist, runtimeSource).target === target,
  'frozen runtime dependency manifest matches platform',
);

// resvg picks its binding by platform at require() time; the single-platform
// archive only needs the matching one.
const resvgBinding = RESVG_BINDINGS[target];
check(existsSync(join(dist, 'node_modules', resvgBinding)), `${resvgBinding} shipped`);

const portProbe = createServer();
await new Promise<void>((done) => portProbe.listen(0, '127.0.0.1', done));
const address = portProbe.address();
if (!address || typeof address === 'string') throw new Error('冒烟端口分配失败');
const PORT = address.port;
await new Promise<void>((done) => portProbe.close(() => done()));
/** 仅本轮日志与导出临时目录，进程退出后清理。 */
const smokeScratch = mkdtempSync(join(tmpdir(), 'weq-smoke-'));

const server = spawn(process.execPath, [join(dist, 'server.mjs')], {
  cwd: dist,
  env: {
    ...process.env,
    WEQ_TOKEN: TOKEN,
    WEQ_HOST: '127.0.0.1',
    WEQ_PORT: String(PORT),
    // Keep the run's droppings out of dist/, which is about to be tarballed.
    WEQ_DATA_DIR: join(smokeScratch, 'weq-data'),
    WEQ_EXPORT_DIR: join(smokeScratch, 'weq-exports'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
let base = '';
let startup = '';
server.stderr.on('data', (c: Buffer) => {
  stderr = (stderr + c.toString()).slice(-16384);
});
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk: string) => {
  startup = (startup + chunk).slice(-4096);
  const match = /WeQ Web\s+→\s+(http:\/\/127\.0\.0\.1:\d+)/u.exec(startup);
  if (match) base = match[1]!;
});

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (server.exitCode !== null) return false;
    if (!base) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
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
    throw new Error('打包服务未能启动');
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
} catch (error) {
  failed++;
  console.error(error instanceof Error ? error.message : '打包服务冒烟失败');
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    const force = setTimeout(() => server.kill('SIGKILL'), 2000);
    try {
      await exited;
    } finally {
      clearTimeout(force);
    }
  }
  rmSync(smokeScratch, { recursive: true, force: true });
}

process.exitCode = failed === 0 ? 0 : 1;
