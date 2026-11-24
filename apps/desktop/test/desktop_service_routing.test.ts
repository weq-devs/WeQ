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
  connectDesktopService,
  listenPrivate,
  openControl,
  PRIVATE_TOKEN_HEADER,
  sendJson,
  stopPrivate,
} from '../src/main/desktop_services/control';
import {
  PRIVATE_ACCOUNT_HEADER,
  type DesktopAccountRoutes,
  type RoutedAccount,
} from '../src/main/desktop_services/accounts';

async function fixture(configIds = ['101', '202'], uins: Record<string, string> = {}) {
  const accounts = configIds.map((configId) => ({
    configId,
    uin: uins[configId] ?? configId,
    displayName: `账号 ${configId}`,
    static: false,
  }));
  const stale = new Set<string>();
  const tcp = createServer((req, res) => {
    const uin = req.headers[PRIVATE_ACCOUNT_HEADER];
    if (req.headers[PRIVATE_TOKEN_HEADER] !== 'a'.repeat(64) || typeof uin !== 'string')
      return sendJson(res, 403, {});
    if (stale.has(uin)) return res.writeHead(401).end();
    if (req.url === '/tool') {
      req.resume();
      return sendJson(res, 200, { value: { uin, downloadPath: '/chat/videos/fixture' } });
    }
    sendJson(res, 200, { uin });
  });
  const port = await listenPrivate(tcp);
  const endpoint = { port, token: 'a'.repeat(64) };
  const find = vi.fn(async (configId: string): Promise<RoutedAccount | undefined> => {
    const account = accounts.find((item) => item.configId === configId);
    if (!account) return undefined;
    return {
      account: { ...account, generation: configId },
      mcp: endpoint,
      browser: endpoint,
      remote: endpoint,
      control: endpoint,
    };
  });
  const open = vi.fn(async (configId: string) => {
    const account = await find(configId);
    if (!account) throw new Error('账号不存在');
    return account;
  });
  const windows = vi.fn(async (): ReturnType<DesktopAccountRoutes['windows']> => []);
  const routes = { list: () => accounts, open, find, windows } as unknown as DesktopAccountRoutes;
  return { routes, open, find, windows, stale, close: () => stopPrivate(tcp) };
}

it('开发重载交接旧桌面服务，旧窗口不会取代新进程', async () => {
  let running = 1;
  let current: Awaited<ReturnType<typeof openControl>> | undefined;
  const retire = vi.fn((next: unknown) => {
    expect(next).toBe(2);
    setImmediate(() => {
      current?.close();
      current = undefined;
    });
    return true;
  });
  const serve = () =>
    openControl((method, input) => {
      if (method === 'service.generation') return running;
      if (method === 'service.retire') return retire(input);
      return true;
    });
  current = await serve();
  const old = current.endpoint;
  const registry = { endpoint: async () => current?.endpoint ?? null };
  const launch = vi.fn(async () => {
    running = 2;
    current = await serve();
  });
  try {
    expect(await connectDesktopService(registry, launch, 1)).toEqual(old);
    expect(launch).not.toHaveBeenCalled();
    const updated = await connectDesktopService(registry, launch, 2);
    expect(updated).not.toEqual(old);
    expect(await connectDesktopService(registry, launch, 1)).toEqual(updated);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    current?.close();
  }
});

it('只返回 ping 的旧桌面服务不算就绪，也不会重复启动争抢实例锁', async () => {
  const legacy = await openControl((method) => {
    if (method === 'ping') return true;
    throw new Error('未知 WeQ 服务命令。');
  });
  const launch = vi.fn(async () => {});
  try {
    await expect(
      connectDesktopService({ endpoint: async () => legacy.endpoint }, launch, 1),
    ).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  } finally {
    legacy.close();
  }
});

it('同一 Web 登录中的两个标签页可以分别读 A、B，退出 A 只释放 A', async () => {
  const worker = await fixture();
  const entry = new DesktopWebEntry({
    accounts: worker.routes,
    publicDir: '/fixture/web',
    loadAccountAvatar: async () => null,
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

it('已有只读客户端只能直连令牌唯一授权的在用账号，不会开窗或切号', async () => {
  const worker = await fixture();
  const token = 'c'.repeat(64);
  let grant = ['101'];
  const gateway = new DesktopMcpGateway(worker.routes, (id) =>
    id === mcpCredentialId(token) ? grant : undefined,
  );
  await gateway.configure({ port: 0, token });
  const call = (name: string, credential = token) =>
    fetch(`http://127.0.0.1:${gateway.boundPort}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }),
    });
  try {
    expect((await call('get_self_profile', 'd'.repeat(64))).status).toBe(401);
    expect((await call('switch_account')).status).toBe(400);
    const response = await (await call('get_self_profile')).json();
    expect(response.id).toBe(1);
    expect(JSON.parse(response.result.content[0].text).uin).toBe('101');
    for (const ids of [[], ['101', '202']]) {
      grant = ids;
      expect((await (await call('get_self_profile')).json()).result.isError).toBe(true);
    }
    grant = ['202'];
    worker.find.mockRejectedValueOnce(new Error('窗口未打开'));
    expect((await (await call('get_self_profile')).json()).result.isError).toBe(true);
    expect(worker.find.mock.calls).toEqual([['101'], ['202']]);
    expect(worker.open).not.toHaveBeenCalled();
  } finally {
    await gateway.stop();
    worker.close();
  }
});

it('远程页面只打开已授权账号，选择失败和服务重启后可重新选择', async () => {
  const worker = await fixture(['101', '202', '303', '404'], { '303': '202' });
  worker.windows.mockResolvedValue([(await worker.find('202'))!]);
  const avatarBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWMQ6d4FAAIQAVpr3peTAAAAAElFTkSuQmCC',
    'base64',
  );
  const loadAccountAvatar = vi.fn(async () => ({ data: avatarBytes, contentType: 'image/png' }));
  let grant = ['101'];
  const publicDir = mkdtempSync(join(tmpdir(), 'weq-scoped-web-'));
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>测试 Web 首屏</title>');
  const createEntry = () =>
    new DesktopWebEntry({
      accounts: worker.routes,
      publicDir,
      loadAccountAvatar,
      auth: {
        remoteClient: true,
        accountIds: () => grant,
        login: async () => false,
        logout: () => {},
        isAuthed: () => true,
        identityKey: () => 'remote-fixture',
        watchSession: () => () => {},
      },
    });
  let entry = createEntry();
  const server = createServer((req, res) => entry.handle(req, res));
  const base = `http://127.0.0.1:${await listenPrivate(server)}`;
  try {
    const shell = await fetch(base, { redirect: 'manual' });
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('测试 Web 首屏');
    const startup = await fetch(base + '/trpc/startup.snapshot');
    expect(startup.headers.get('x-weq-account-selection')).toBe('required');
    const first = await fetch(base + '/_weq/accounts?resume=1', { redirect: 'manual' });
    expect(first.headers.get('location')).toMatch(/^\/_weq\/account\/101\//);

    grant = ['101', '202', '303'];
    worker.open.mockClear();
    const picker = await fetch(base + '/_weq/accounts?resume=1', { redirect: 'manual' });
    expect(picker.status).toBe(200);
    const list = await picker.text();
    expect(list).toContain('账号 101');
    expect(list).toContain('账号 202');
    expect(list).toContain('账号 303');
    expect(list).not.toContain('账号 404');
    const row = (configId: string) =>
      list.split('</form>').find((part) => part.includes(`value="${configId}"`));
    expect(row('202')).toContain('WeQ 在线');
    expect(row('303')).toContain('WeQ 离线');
    expect(loadAccountAvatar).not.toHaveBeenCalled();
    expect(row('202')).toContain('/_weq/account-avatar?configId=202');
    const avatar = await fetch(`${base}/_weq/account-avatar?configId=202`);
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await avatar.arrayBuffer())).toEqual(avatarBytes);
    expect((await fetch(`${base}/_weq/account-avatar?configId=404`)).status).toBe(404);
    expect(loadAccountAvatar.mock.calls).toEqual([['202']]);
    const select = (configId: string) =>
      fetch(base + '/_weq/select-account', {
        method: 'POST',
        headers: { authorization: `Bearer ${'a'.repeat(64)}` },
        body: new URLSearchParams({ configId }),
        redirect: 'manual',
      });
    expect((await select('404')).status).toBe(200);
    expect(worker.open).not.toHaveBeenCalled();
    worker.open.mockRejectedValueOnce(new Error('账号尚未就绪'));
    expect((await select('202')).status).toBe(200);
    const selected = await select('202');
    expect(selected.status).toBe(303);
    const accountPath = selected.headers.get('location')!;
    const switchPath = `${base}${accountPath}_weq/switch-account`;
    expect((await fetch(switchPath, { method: 'HEAD' })).status).toBe(204);
    const switching = await fetch(switchPath, { redirect: 'manual' });
    expect(switching.status).toBe(200);
    expect(await switching.text()).toContain(`href="${accountPath}"`);
    const choices = await fetch(switchPath, { headers: { accept: 'application/json' } });
    expect(choices.headers.get('cache-control')).toBe('no-store');
    expect(await choices.json()).toMatchObject([
      { configId: '101', online: false },
      { configId: '202', online: true, avatarUrl: '/_weq/account-avatar?configId=202' },
      { configId: '303', online: false },
    ]);
    const changeAccount = (configId: string, accept = 'text/html') =>
      fetch(`${base}${accountPath}_weq/select-account`, {
        method: 'POST',
        headers: { authorization: `Bearer ${'a'.repeat(64)}`, accept },
        body: new URLSearchParams({ configId }),
        redirect: 'manual',
      });
    expect(await (await changeAccount('404')).text()).toContain(`href="${accountPath}"`);
    expect((await changeAccount('101')).headers.get('location')).toMatch(/^\/_weq\/account\/101\//);
    const denied = await changeAccount('404', 'application/json');
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: '此账号未授权。' });
    const changed = await changeAccount('101', 'application/json');
    expect(changed.status).toBe(200);
    const destination = (await changed.json()).location;
    expect(destination).toMatch(/^\/_weq\/account\/101\//);
    expect(await (await fetch(`${base}${destination}trpc/startup.snapshot`)).json()).toEqual({
      uin: '101',
    });
    grant = ['202'];
    expect((await fetch(switchPath, { method: 'HEAD' })).status).toBe(404);
    grant = ['101', '202', '303'];
    const route = accountPath.split('/').at(-2);
    const media = await fetch(`${base}/_media/pic?cid=test~${route}`);
    expect(await media.json()).toEqual({ uin: '202' });

    const snapshotPath = `${base}${accountPath}trpc/startup.snapshot`;
    expect(await (await fetch(snapshotPath)).json()).toEqual({ uin: '202' });
    worker.stale.add('202');
    const closedAccount = await fetch(snapshotPath);
    expect(closedAccount.status).toBe(409);
    expect(closedAccount.headers.get('x-weq-account-selection')).toBe('required');
    expect((await fetch(snapshotPath, { method: 'POST' })).status).toBe(401);
    worker.stale.delete('202');
    entry.close();
    entry = createEntry();
    worker.open.mockClear();
    for (const path of ['startup.snapshot', 'account.listRecentContacts?batch=1']) {
      const stale = await fetch(`${base}${accountPath}trpc/${path}`);
      expect(stale.status).toBe(409);
      expect(stale.headers.get('x-weq-account-selection')).toBe('required');
    }
    const staleWrite = await fetch(`${base}${accountPath}trpc/account.sendMessage`, {
      method: 'POST',
    });
    expect(staleWrite.status).toBe(409);
    expect(staleWrite.headers.has('x-weq-account-selection')).toBe(false);
    expect(worker.open).not.toHaveBeenCalled();
    const resume = (configId: string) =>
      fetch(`${base}/_weq/accounts?resume=1&last=${configId}`, { redirect: 'manual' });
    const resumed = await resume('202');
    expect(resumed.status).toBe(303);
    expect(resumed.headers.get('location')).toMatch(/^\/_weq\/account\/202\//);
    worker.find.mockResolvedValueOnce(undefined);
    expect((await resume('303')).status).toBe(200);
    grant = ['101'];
    worker.find.mockClear();
    const revoked = await resume('202');
    expect(revoked.status).toBe(200);
    expect(await revoked.text()).not.toContain('账号 202');
    expect(worker.find).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  } finally {
    entry.close();
    stopPrivate(server);
    worker.close();
    rmSync(publicDir, { recursive: true, force: true });
  }
});

it('Remote 下载正式及开发网页的启动脚本时不需要先选账号', async () => {
  const worker = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'weq-scoped-web-startup-'));
  const startupTheme = 'window.startupTheme = true;';
  writeFileSync(join(dir, 'startup-theme.js'), startupTheme);
  const scripts = new Map([
    ['/startup-theme.js', startupTheme],
    ['/bundledDevClient.mjs', 'export const developmentClient = true;'],
    ['/@rolldown/experimental-runtime.mjs', 'export const runtime = true;'],
  ]);
  const upstream = createServer((req, res) => {
    const body = scripts.get(req.url ?? '');
    if (!body) return res.writeHead(404).end();
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(body);
  });
  const developmentUrl = `http://127.0.0.1:${await listenPrivate(upstream)}`;
  let allowed = true;
  const publicOptions = {
    accounts: worker.routes,
    publicDir: dir,
    loadAccountAvatar: async () => null,
    auth: {
      remoteClient: true,
      login: async () => false,
      logout: () => {},
      isAuthed: () => allowed,
      watchSession: () => () => {},
    },
  };
  const entry = new DesktopWebEntry(publicOptions);
  const dev = new DesktopWebEntry({ ...publicOptions, developmentUrl });
  const server = createServer((req, res) =>
    (req.headers['x-fixture-dev'] ? dev : entry).handle(req, res),
  );
  const base = `http://127.0.0.1:${await listenPrivate(server)}`;
  try {
    const theme = await fetch(`${base}/startup-theme.js`);
    expect(theme.status).toBe(200);
    expect(await theme.text()).toBe(startupTheme);
    const headers = { 'x-fixture-dev': '1', 'user-agent': 'WeQRemote' };
    for (const [path, content] of scripts) {
      const response = await fetch(base + path, { headers });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(content);
    }
    allowed = false;
    expect((await fetch(`${base}/startup-theme.js`)).status).toBe(401);
    expect((await fetch(`${base}/bundledDevClient.mjs`, { headers })).status).toBe(401);
    expect(worker.open).not.toHaveBeenCalled();
  } finally {
    entry.close();
    dev.close();
    stopPrivate(server);
    stopPrivate(upstream);
    worker.close();
    rmSync(dir, { recursive: true, force: true });
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
