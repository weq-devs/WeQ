// @vitest-environment node
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it, vi } from 'vitest';
import { DesktopWebEntry } from '../src/main/desktop_services/web_entry';
import { createWebHost, lookupDownload } from '../src/main/web/host';
import { withWebAccountRoute } from '../src/main/web/account_route';
import { DesktopMcpGateway, mcpCredentialId } from '../src/main/desktop_services/mcp_gateway';
import {
  listenPrivate,
  PRIVATE_TOKEN_HEADER,
  sendJson,
  stopPrivate,
} from '../src/main/desktop_services/control';
import {
  PRIVATE_ACCOUNT_HEADER,
  type DesktopAccountRoutes,
} from '../src/main/desktop_services/accounts';

async function fixture() {
  const accounts = ['101', '202'].map((configId) => ({
    configId,
    uin: configId,
    displayName: `账号 ${configId}`,
    static: false,
  }));
  const tcp = createServer((req, res) => {
    const uin = req.headers[PRIVATE_ACCOUNT_HEADER];
    if (req.headers[PRIVATE_TOKEN_HEADER] !== 'a'.repeat(64) || typeof uin !== 'string')
      return sendJson(res, 403, {});
    if (req.url === '/tool') {
      req.resume();
      return sendJson(res, 200, { value: { uin, downloadPath: '/chat/videos/fixture' } });
    }
    sendJson(res, 200, { uin });
  });
  const port = await listenPrivate(tcp);
  const endpoint = { port, token: 'a'.repeat(64) };
  const open = vi.fn(async (configId: string) => {
    const account = accounts.find((item) => item.configId === configId);
    if (!account) throw new Error('账号不存在');
    return {
      account: { ...account, generation: configId },
      mcp: endpoint,
      browser: endpoint,
      remote: endpoint,
      control: endpoint,
    };
  });
  const routes = { list: () => accounts, open } as unknown as DesktopAccountRoutes;
  return { routes, open, close: () => stopPrivate(tcp) };
}

it('同一 Web 登录中的两个标签页可以分别读 A、B，退出 A 只释放 A', async () => {
  const worker = await fixture();
  const entry = new DesktopWebEntry({
    accounts: worker.routes,
    publicDir: '/fixture/web',
    auth: {
      login: async () => false,
      logout: () => {},
      isAuthed: (req) => !!req.headers.cookie,
      identityKey: (req) => req.headers.cookie ?? null,
      watchSession: () => () => {},
    },
  });
  const server = createServer((req, res) => entry.handle(req, res));
  const base = `http://127.0.0.1:${await listenPrivate(server)}`;
  entry.attach(server);
  const headers = { cookie: 'fixture=one', origin: base };
  const open = async (configId: string) => {
    const response = await fetch(base + '/_weq/select-account', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ configId }),
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    return base + response.headers.get('location');
  };
  try {
    const a = await open('101');
    const b = await open('202');
    expect(await (await fetch(a + 'trpc/fixture', { headers })).json()).toEqual({ uin: '101' });
    expect(await (await fetch(b + 'trpc/fixture', { headers })).json()).toEqual({ uin: '202' });
    expect((await fetch(a + 'trpc/fixture', { headers: { cookie: 'fixture=other' } })).status).toBe(
      409,
    );
    expect((await fetch(a + '_weq/leave-account', { method: 'POST', headers })).status).toBe(204);
    expect((await fetch(a + 'trpc/fixture', { headers })).status).toBe(409);
    expect(await (await fetch(b + 'trpc/fixture', { headers })).json()).toEqual({ uin: '202' });
  } finally {
    entry.close();
    stopPrivate(server);
    worker.close();
  }
});

it('MCP 会话独立切号，旧下载票据随原会话切号失效', async () => {
  const worker = await fixture();
  const token = 'c'.repeat(64);
  const gateway = new DesktopMcpGateway(worker.routes, (id) =>
    id === mcpCredentialId(token) ? ['101', '202'] : undefined,
  );
  await gateway.configure({ port: 0, token });
  const base = `http://127.0.0.1:${gateway.boundPort}`;
  const headers = { Authorization: `Bearer ${token}` };
  const a = new Client({ name: 'fixture-a', version: '1' });
  const b = new Client({ name: 'fixture-b', version: '1' });
  const connect = (client: Client) =>
    client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers } }));
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError).not.toBe(true);
    return JSON.parse((response.content as { text: string }[])[0]!.text);
  };
  try {
    await Promise.all([connect(a), connect(b)]);
    await call(a, 'switch_account', { configId: '101' });
    await call(b, 'switch_account', { configId: '202' });
    const old = await call(a, 'get_self_profile');
    expect(old.uin).toBe('101');
    expect((await call(b, 'get_self_profile')).uin).toBe('202');
    expect((await fetch(base + old.downloadPath, { headers })).status).toBe(200);
    await call(a, 'switch_account', { configId: '202' });
    expect((await fetch(base + old.downloadPath, { headers })).status).toBe(404);
    expect((await call(b, 'get_self_profile')).uin).toBe('202');
  } finally {
    await Promise.all([a.close(), b.close()]);
    await gateway.stop();
    worker.close();
  }
});

it('远程页面只列出已授权账号，手工提交未授权账号也不会启动它', async () => {
  const worker = await fixture();
  const publicDir = mkdtempSync(join(tmpdir(), 'weq-scoped-web-'));
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>测试 Web 首屏</title>');
  const entry = new DesktopWebEntry({
    accounts: worker.routes,
    publicDir,
    auth: {
      remoteClient: true,
      accountIds: () => ['101'],
      login: async () => false,
      logout: () => {},
      isAuthed: () => true,
      identityKey: () => 'remote-fixture',
      watchSession: () => () => {},
    },
  });
  const server = createServer((req, res) => entry.handle(req, res));
  const base = `http://127.0.0.1:${await listenPrivate(server)}`;
  try {
    const shell = await fetch(base, { redirect: 'manual' });
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('测试 Web 首屏');
    const startup = await fetch(base + '/trpc/startup.snapshot');
    expect(startup.headers.get('x-weq-account-selection')).toBe('required');
    const list = await (await fetch(base + '/_weq/accounts')).text();
    expect(list).toContain('账号 101');
    expect(list).not.toContain('账号 202');
    const denied = await fetch(base + '/_weq/select-account', {
      method: 'POST',
      headers: { origin: base },
      body: new URLSearchParams({ configId: '202' }),
      redirect: 'manual',
    });
    expect(denied.status).toBe(409);
    expect(worker.open).not.toHaveBeenCalled();
    const first = await fetch(base + '/_weq/accounts?resume=1', { redirect: 'manual' });
    expect(first.headers.get('location')).toMatch(/^\/_weq\/account\/101\//);
    const selected = await fetch(base + '/_weq/select-account', {
      method: 'POST',
      headers: { authorization: `Bearer ${'a'.repeat(64)}` },
      body: new URLSearchParams({ configId: '101' }),
      redirect: 'manual',
    });
    expect(selected.status).toBe(303);
    const route = selected.headers.get('location')!.split('/').at(-2);
    const media = await fetch(`${base}/_media/pic?cid=test~${route}`);
    expect(await media.json()).toEqual({ uin: '101' });
  } finally {
    entry.close();
    stopPrivate(server);
    worker.close();
    rmSync(publicDir, { recursive: true, force: true });
  }
});

it('固定网页会话签发的文件下载不能交给另一个会话', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-scoped-download-'));
  const a = '/_weq/account/101/11111111-1111-4111-8111-111111111111';
  const b = '/_weq/account/101/22222222-2222-4222-8222-222222222222';
  try {
    const host = createWebHost({ exportDir: root, version: 'test' });
    const download = withWebAccountRoute(a, () =>
      host.registerDownload!(join(root, 'test.txt'), 'test.txt', 'file'),
    );
    expect(download.url.startsWith(`${a}/_download/`)).toBe(true);
    const id = download.url.split('/').at(-1)!;
    expect(withWebAccountRoute(a, () => lookupDownload(id))).toBeDefined();
    expect(withWebAccountRoute(b, () => lookupDownload(id))).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
