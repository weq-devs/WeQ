// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import { getHost, setHost } from '@weq/service';
import { DesktopWebRuntime } from '../src/main/web/runtime';
import { WebCore } from '../src/main/web/application';
import { createWebHost } from '../src/main/web/host';
import { RemotePairing, tokenHash } from '../src/main/remote/pairing';
import { createRemoteServer } from '../src/main/remote/http';
import { RemoteWebGateway } from '../src/main/remote/web_gateway';
import { RemoteRuntime } from '../src/main/remote/runtime';
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
  const core = new WebCore({
    publicDir,
    exportDir: join(root, 'exports'),
    version: 'test',
    router: router({
      webHost: procedure.query(() => ({
        canReveal: getHost().canReveal,
        version: getHost().appVersion(),
      })),
      reportCapture: procedure.mutation(async () =>
        (await getHost().renderHtmlToPdf('fixture')).toString(),
      ),
      remote: remoteRouter,
      update: updateRouter,
    }),
    renderer: {
      renderHtmlToPdf: async () => Buffer.from('fixture-pdf'),
      renderHtmlToLongPng: async () => Buffer.from('fixture-png'),
      renderHtmlToSlidesPng: async () => [Buffer.from('fixture-slide')],
    },
  });
  runtime.configure({
    core,
    getAutoStart: () => autoStart,
    setAutoStart: (enabled) => {
      autoStart = enabled;
    },
  });
  return { root, runtime, pairing, core };
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
  const { runtime, pairing, root, core } = fixture();
  const assets = join(root, 'public', 'assets');
  mkdirSync(assets);
  const code = 'console.log("合成远程资源");\n'.repeat(1000);
  writeFileSync(join(assets, 'index-Abcd1234.js'), code);
  const desktop = {
    ...createWebHost({ exportDir: join(root, 'desktop'), version: 'desktop' }),
    canReveal: true,
  };
  setHost(desktop);
  const server = createRemoteServer(
    pairing,
    new RemoteWebGateway(pairing, (auth) => core.entry(auth)),
  );
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
    expect(runtime.status()).toMatchObject({ enabled: false, port: null, autoStart: false });
    expect(() => runtime.accessToken()).toThrow();
    expect(await (await fetch(base, { headers })).text()).toContain('WeQ fixture');
    const compressed = await fetch(`${base}/assets/index-Abcd1234.js`, {
      headers: { ...headers, 'Accept-Encoding': 'gzip' },
    });
    expect(compressed.headers.get('content-encoding')).toBe('gzip');
    expect(compressed.headers.get('vary')).toBe('Accept-Encoding');
    expect(await compressed.text()).toBe(code);
    const reply = await (await fetch(`${base}/trpc/webHost`, { headers })).json();
    expect(reply.result.data.json).toEqual({ canReveal: false, version: 'test' });
    const captured = await (
      await fetch(`${base}/trpc/reportCapture`, { method: 'POST', headers })
    ).json();
    expect(captured.result.data.json).toBe('fixture-pdf');
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
    await runtime.start();
    const localUrl = runtime.status().url!;
    expect((await fetch(localUrl, { headers })).status).toBe(401);
    const login = await fetch(`${localUrl}/_auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: runtime.accessToken() }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(base, { headers: { cookie } })).status).toBe(403);
    runtime.stop();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect((await fetch(`${base}/trpc/webHost`, { headers })).status).toBe(200);
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
    expect((await fetch(base, { headers })).status).toBe(200);
    expect(pairing.canAccessWeb(token)).toBe(true);
    await runtime.start();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect((await fetch(runtime.status().url!)).status).toBe(401);
  } finally {
    socket?.terminate();
    pairing.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('Remote 独立停止与恢复，仅关闭自身 HTTP 和订阅，保留本机登录与订阅', async () => {
  const { runtime, root, core } = fixture();
  const children: ChildProcessWithoutNullStreams[] = [];
  let base = '';
  const launch = ((_command: string, args: string[]) => {
    base = args[args.indexOf('--backend') + 1]!;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitCode: null,
      kill() {
        this.emit('exit', 0);
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    children.push(child);
    return child;
  }) as typeof spawn;
  const remote = new RemoteRuntime(launch);
  remote.configure({
    helper: process.execPath,
    stateDir: join(root, 'remote'),
    web: () => new RemoteWebGateway(remote.pairing, (auth) => core.entry(auth)),
  });
  let localSocket: WebSocket | undefined;
  let remoteSocket: WebSocket | undefined;
  try {
    await remote.start();
    expect(runtime.status()).toMatchObject({ enabled: false, port: null, autoStart: false });
    const token = 'e'.repeat(64);
    const headers = { Authorization: `Bearer ${token}` };
    const claim = remote.pairing.claim({
      invitation: remote.pairing.invite().secret,
      name: '合成手机',
      tokenHash: tokenHash(token),
      scope: 'web:access',
    });
    remote.pairing.decide(claim.id, true);
    expect((await fetch(base, { headers })).status).toBe(200);
    remoteSocket = new WebSocket(`${base.replace('http:', 'ws:')}/trpc-ws`, { headers });
    await once(remoteSocket, 'open');

    await runtime.start();
    const local = runtime.status().url!;
    const login = await fetch(`${local}/_auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: runtime.accessToken() }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    localSocket = new WebSocket(`${local.replace('http:', 'ws:')}/trpc-ws`, {
      headers: { cookie },
    });
    await once(localSocket, 'open');
    const closed = once(remoteSocket, 'close');
    remote.stop();
    await closed;
    expect(localSocket.readyState).toBe(WebSocket.OPEN);
    expect((await fetch(`${local}/trpc/webHost`, { headers: { cookie } })).status).toBe(200);
    expect(remote.pairing.canAccessWeb(token)).toBe(true);
    runtime.stop();
    await remote.resume();
    expect(runtime.status()).toMatchObject({ enabled: false, autoStart: false, port: null });
    expect((await fetch(`${base}/trpc/webHost`, { headers })).status).toBe(200);
    expect(children).toHaveLength(2);
    remote.stop(true);
    await remote.resume();
    expect(children).toHaveLength(2);
  } finally {
    localSocket?.terminate();
    remoteSocket?.terminate();
    remote.stop();
    for (const child of children) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    }
  }
});
