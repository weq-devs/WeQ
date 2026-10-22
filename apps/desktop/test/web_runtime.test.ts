// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import { getHost, setHost } from '@weq/service';
import { DesktopWebRuntime } from '../src/main/web/runtime';
import { createWebHost } from '../src/main/web/host';
import { RemotePairing, tokenHash } from '../src/main/remote/pairing';
import { createRemoteServer } from '../src/main/remote/http';
import { procedure, router } from '../src/main/ipc/trpc';
import { remoteRouter } from '../src/main/ipc/routers/remote';
import { updateRouter } from '../src/main/ipc/routers/update';

const roots: string[] = [];
const runtimes: DesktopWebRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-web-runtime-'));
  roots.push(root);
  const publicDir = join(root, 'public');
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>WeQ fixture</title>');
  const pairing = new RemotePairing();
  const runtime = new DesktopWebRuntime();
  runtimes.push(runtime);
  let autoStart = false;
  runtime.configure({
    publicDir,
    exportDir: join(root, 'exports'),
    version: 'test',
    pairing,
    router: router({
      webHost: procedure.query(() => ({
        canReveal: getHost().canReveal,
        version: getHost().appVersion(),
      })),
      remote: remoteRouter,
      update: updateRouter,
    }),
    getAutoStart: () => autoStart,
    setAutoStart: (enabled) => {
      autoStart = enabled;
    },
  });
  return { root, runtime, pairing };
}

it('Web 服务独立启停，令牌不进入状态，自动启动偏好不等于当前运行状态', async () => {
  const { runtime } = fixture();
  expect(runtime.status()).toMatchObject({ enabled: false, autoStart: false });
  runtime.setAutoStart(true);
  expect(runtime.status()).toMatchObject({ enabled: false, autoStart: true });
  await runtime.start();
  const url = runtime.status().url!;
  expect((await fetch(`${url}/trpc/webHost`, { headers: { Connection: 'close' } })).status).toBe(
    401,
  );
  const token = runtime.accessToken();
  expect(JSON.stringify(runtime.status())).not.toContain(token);
  const login = await fetch(`${url}/_auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ token }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect((await fetch(url, { headers: { cookie, Connection: 'close' } })).status).toBe(200);
  runtime.stop();
  expect(runtime.status()).toMatchObject({ enabled: false, autoStart: true, port: null });
  expect(() => runtime.accessToken()).toThrow();
  await runtime.start();
  expect(runtime.accessToken()).not.toBe(token);
  expect(
    (
      await fetch(`${runtime.status().url}/trpc/webHost`, {
        headers: { cookie, Connection: 'close' },
      })
    ).status,
  ).toBe(401);
});

it('手机完整 Web 权限需单独批准，隔离宿主和本机管理，撤销会关闭 WebSocket', async () => {
  const { runtime, pairing, root } = fixture();
  const assets = join(root, 'public', 'assets');
  mkdirSync(assets);
  const code = 'console.log("合成远程资源");\n'.repeat(1000);
  writeFileSync(join(assets, 'index-Abcd1234.js'), code);
  const desktop = {
    ...createWebHost({ exportDir: join(root, 'desktop'), version: 'desktop' }),
    canReveal: true,
  };
  setHost(desktop);
  await runtime.start();
  const server = createRemoteServer(pairing, () => runtime.status().port);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('missing listener');
  const base = `http://127.0.0.1:${bound.port}`;
  const token = 'a'.repeat(64);
  const headers = { Authorization: `Bearer ${token}` };
  let socket: WebSocket | null = null;
  try {
    const statusOnly = pairing.claim({
      invitation: pairing.invite().secret,
      name: '旧版手机',
      tokenHash: tokenHash('b'.repeat(64)),
    });
    pairing.decide(statusOnly.id, true);
    expect(
      (await fetch(base, { headers: { Authorization: `Bearer ${'b'.repeat(64)}` } })).status,
    ).toBe(403);
    const claim = pairing.claim({
      invitation: pairing.invite().secret,
      name: '手机',
      tokenHash: tokenHash(token),
      scope: 'web:access',
    });
    expect((await fetch(base, { headers })).status).toBe(403);
    pairing.decide(claim.id, true);
    expect(await (await fetch(base, { headers })).text()).toContain('WeQ fixture');
    const compressed = await fetch(`${base}/assets/index-Abcd1234.js`, {
      headers: { ...headers, 'Accept-Encoding': 'gzip' },
    });
    expect(compressed.headers.get('content-encoding')).toBe('gzip');
    expect(compressed.headers.get('vary')).toBe('Accept-Encoding');
    expect(await compressed.text()).toBe(code);
    const reply = await (await fetch(`${base}/trpc/webHost`, { headers })).json();
    expect(reply.result.data.json).toEqual({ canReveal: false, version: 'test' });
    expect(getHost()).toBe(desktop);
    expect((await fetch(`${base}/trpc/remote.status`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/trpc/update.install`, { method: 'POST', headers })).status).toBe(
      403,
    );
    expect(
      (await fetch(base, { headers: { ...headers, Origin: 'https://evil.invalid' } })).status,
    ).toBe(403);
    socket = new WebSocket(base.replace('http:', 'ws:') + '/trpc-ws', { headers });
    await once(socket, 'open');
    const closed = once(socket, 'close');
    pairing.revoke(claim.id);
    await closed;
    expect((await fetch(`${base}/trpc/webHost`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/assets/index-Abcd1234.js`, { headers })).status).toBe(403);
    const next = pairing.claim({
      invitation: pairing.invite().secret,
      name: '新手机',
      tokenHash: tokenHash(token),
      scope: 'web:access',
    });
    pairing.decide(next.id, true);
    runtime.stop();
    expect((await fetch(base, { headers })).status).toBe(503);
    expect(pairing.canAccessWeb(token)).toBe(true);
  } finally {
    socket?.terminate();
    pairing.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
