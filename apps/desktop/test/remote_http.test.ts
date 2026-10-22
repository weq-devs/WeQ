// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteServer } from '../src/main/remote/http';
import { RemotePairing, tokenHash } from '../src/main/remote/pairing';

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

  it('限制未认证请求频率', async () => {
    for (let i = 0; i < 120; i++) await fetch(`${base}/v1/status`);
    expect((await fetch(`${base}/v1/status`)).status).toBe(429);
  });
});
