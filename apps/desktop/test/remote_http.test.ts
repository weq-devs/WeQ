// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteServer } from '../src/main/remote/http';
import { RemotePairing, tokenHash } from '../src/main/remote/pairing';
import { initTRPC } from '@trpc/server';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';

describe('远程原型的最小 HTTP 面', () => {
  let pairing: RemotePairing;
  let server: ReturnType<typeof createRemoteServer>;
  let base: string;
  const token = 'c'.repeat(64);
  const headers = { Authorization: `Bearer ${token}` };

  beforeEach(async () => {
    pairing = new RemotePairing();
    server = createRemoteServer(pairing);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('没有监听端口');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('完成申请、确认、轮询、状态读取和撤销的真实 HTTP 往返', async () => {
    const invitationBeforeProbe = pairing.invite();
    const hello = await fetch(`${base}/v1/hello`);
    expect(hello.status).toBe(200);
    expect(await hello.json()).toEqual({ product: 'WeQ Remote', protocol: 1 });
    expect(pairing.snapshot().invitationExpiresAt).toBe(invitationBeforeProbe.expiresAt);
    expect(pairing.snapshot().pending).toEqual([]);
    expect((await fetch(`${base}/v1/status`, { headers })).status).toBe(401);
    const invitation = pairing.invite().secret;
    const response = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitation, name: '手机', tokenHash: tokenHash(token) }),
    });
    expect(response.status).toBe(201);
    const request = (await response.json()) as { id: string };
    expect((await fetch(`${base}/v1/status`, { headers })).status).toBe(401);
    expect(
      (await (await fetch(`${base}/v1/pair/${request.id}`, { headers })).json()).approved,
    ).toBe(false);
    pairing.decide(request.id, true);
    const status = await fetch(`${base}/v1/status`, { headers });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      product: 'WeQ Remote',
      protocol: 1,
      scope: 'status:read',
      online: true,
    });
    expect((await fetch(`${base}/trpc`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/v1/approve`, { method: 'POST', headers })).status).toBe(404);
    pairing.revoke(request.id);
    expect((await fetch(`${base}/v1/status`, { headers })).status).toBe(401);
  });

  it('拒绝跨源浏览器、非 JSON、无效和过大请求', async () => {
    expect(
      (await fetch(`${base}/v1/pair`, { headers: { Origin: 'https://invalid.example' } })).status,
    ).toBe(403);
    expect((await fetch(`${base}/v1/pair`, { method: 'POST', body: '{}' })).status).toBe(415);
    expect(
      (
        await fetch(`${base}/v1/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400);
    expect((await fetch(`${base}/v1/status?token=${token}`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/v1/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: ' '.repeat(5000),
        })
      ).status,
    ).toBe(413);
  });

  it('旧配对正文保持不变，设备资料随请求头补齐；无效请求头不影响已有授权', async () => {
    const info = {
      platform: 'android',
      model: 'Test Phone',
      osVersion: '16',
      appVersion: '1.0.0b3',
      appBuild: '9',
    };
    const metadata = { 'X-WeQ-Device': Buffer.from(JSON.stringify(info)).toString('base64') };
    const response = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { ...metadata, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invitation: pairing.invite().secret,
        name: '测试',
        tokenHash: tokenHash(token),
      }),
    });
    expect(response.status).toBe(201);
    const claim = (await response.json()) as { id: string };
    pairing.decide(claim.id, true);
    expect(pairing.snapshot().devices[0]?.deviceInfo).toEqual(info);
    await fetch(`${base}/v1/status`, {
      headers: { ...headers, ...metadata, 'X-Forwarded-For': '8.8.8.8, 100.64.0.9' },
    });
    expect(pairing.snapshot().devices[0]).toMatchObject({
      deviceInfo: info,
      lastConnection: { ip: '100.64.0.9', route: 'tailscale' },
    });
    expect(
      (await fetch(`${base}/v1/status`, { headers: { ...headers, 'X-WeQ-Device': 'bad' } })).status,
    ).toBe(200);
    expect(pairing.snapshot().devices[0]?.deviceInfo).toEqual(info);
  });

  it('未授权请求耗尽自己的配额后，合法设备仍能使用 Remote', async () => {
    const claim = pairing.claim({
      invitation: pairing.invite().secret,
      name: '合法手机',
      tokenHash: tokenHash(token),
    });
    pairing.decide(claim.id, true);
    for (let i = 0; i < 120; i++) {
      expect((await fetch(`${base}/v1/hello`)).status).toBe(200);
    }
    expect((await fetch(`${base}/v1/hello`)).status).toBe(429);
    expect((await fetch(`${base}/v1/status`, { headers })).status).toBe(200);
  });

  it('限制未认证请求频率', async () => {
    for (let i = 0; i < 120; i++) await fetch(`${base}/v1/status`);
    expect((await fetch(`${base}/v1/status`)).status).toBe(429);
  });
});

it('Remote 保留超过十秒的业务批次，同时独立任务读取无需等待', async () => {
  const t = initTRPC.create();
  let started!: () => void;
  const slowStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const handler = createHTTPHandler({
    router: t.router({
      slow: t.procedure.query(async () => {
        started();
        await new Promise((resolve) => setTimeout(resolve, 11_000));
        return 'finished';
      }),
      tasks: t.procedure.query(() => [{ progress: 50 }]),
      logs: t.procedure.query(() => ['task log']),
    }),
  });
  const server = createRemoteServer(new RemotePairing(), {
    handle(req, res) {
      req.url = req.url!.slice('/trpc'.length);
      void handler(req, res);
    },
    attach() {},
    close() {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('没有监听端口');
  const base = `http://127.0.0.1:${address.port}/trpc`;
  try {
    const pending = fetch(`${base}/slow,tasks,logs?batch=1&input=%7B%7D`, {
      signal: AbortSignal.timeout(15_000),
    }).then((response) => response.json());
    // 立即安装拒绝处理器，避免旧实现超时断开时出现未处理拒绝。
    const result = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await slowStarted;
    const fast = await fetch(`${base}/tasks,logs?batch=1&input=%7B%7D`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(await fast.json()).toEqual([
      { result: { data: [{ progress: 50 }] } },
      { result: { data: ['task log'] } },
    ]);
    expect(await result).toEqual({
      value: [
        { result: { data: 'finished' } },
        { result: { data: [{ progress: 50 }] } },
        { result: { data: ['task log'] } },
      ],
    });
    expect(server.headersTimeout).toBe(10_000);
    expect(server.requestTimeout).toBe(10_000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);
