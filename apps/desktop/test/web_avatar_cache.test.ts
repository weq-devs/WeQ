// @vitest-environment node
import type { IncomingMessage } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startServer } from '../src/main/web/http';
import { toProtocolRequest } from '../src/main/web/protocol_adapter';

const mock = vi.hoisted(() => ({ localFile: vi.fn(), get: vi.fn(), resourceRoot: vi.fn() }));
vi.mock('../src/main/resource', () => ({ resolveResourceRoot: mock.resourceRoot }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    bootstrap: { avatarCache: { get: mock.get, cachedAt: async () => null } },
    services: { avatarResource: { resolveByUidFile: mock.localFile } },
  }),
}));

let dir = '';
let base = '';
let allowed = true;
let server: Awaited<ReturnType<typeof startServer>>['server'];
const avatar = '/_media/avatar?scope=group&uid=123&v=small';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'weq-web-avatar-'));
  const path = join(dir, 's_avatar.png');
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Cache fixture</title>');
  await writeFile(path, 'synthetic-avatar');
  await mkdir(join(dir, 'brand'));
  await writeFile(join(dir, 'brand', 'fixture.txt'), 'bundled-resource');
  mock.resourceRoot.mockReturnValue(dir);
  mock.localFile.mockReset().mockResolvedValue({ path, stale: false, mtimeMs: 1 });
  mock.get.mockReset().mockResolvedValue({ data: Buffer.from('cdn'), contentType: 'image/png' });
  allowed = true;
  const started = await startServer({
    port: 0,
    host: '127.0.0.1',
    publicDir: dir,
    auth: { isAuthed: () => allowed, login: async () => false, logout: () => {} },
    trpc: (_req, res) => res.end('business'),
  });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await rm(dir, { recursive: true, force: true });
});

it('协议适配保留缓存验证和范围头，不透传认证凭据', () => {
  const request = toProtocolRequest(
    {
      url: avatar,
      headers: {
        'if-modified-since': 'Wed, 11 Nov 2026 01:00:00 GMT',
        'if-none-match': '"fixture"',
        range: 'bytes=0-10',
        authorization: 'secret',
      },
    } as IncomingMessage,
    'weq-media',
    '/_media',
  )!;
  expect(request.headers.get('if-modified-since')).toBe('Wed, 11 Nov 2026 01:00:00 GMT');
  expect(request.headers.get('if-none-match')).toBe('"fixture"');
  expect(request.headers.get('range')).toBe('bytes=0-10');
  expect(request.headers.has('authorization')).toBe(false);
});

it('本地头像允许五分钟浏览器复用，过期后未修改仅返回 304，不重复传图片', async () => {
  const first = await fetch(base + avatar);
  expect(first.headers.get('cache-control')).toBe('private, max-age=300');
  expect(await first.text()).toBe('synthetic-avatar');
  const response = await fetch(base + avatar, {
    headers: { 'If-Modified-Since': first.headers.get('last-modified')! },
  });
  expect(response.status).toBe(304);
  expect(await response.text()).toBe('');
  expect(response.headers.get('cache-control')).toBe('private, max-age=300');
  expect(mock.get).not.toHaveBeenCalled();
});

it('本地头像同秒同大小更新仍可识别，ETag 优先于秒级修改时间', async () => {
  const path = join(dir, 's_avatar.png');
  await utimes(path, 1_700_000_000.1, 1_700_000_000.1);
  const first = await fetch(base + avatar);
  const etag = first.headers.get('etag');
  const modified = first.headers.get('last-modified')!;
  expect(etag).toBeTruthy();
  await first.text();
  await writeFile(path, 'changed-avatar!!');
  await utimes(path, 1_700_000_000.2, 1_700_000_000.2);
  const changed = await fetch(base + avatar, {
    headers: { 'If-None-Match': etag!, 'If-Modified-Since': modified },
  });
  expect(changed.status).toBe(200);
  expect(changed.headers.get('last-modified')).toBe(modified);
  expect(changed.headers.get('etag')).not.toBe(etag);
  expect(await changed.text()).toBe('changed-avatar!!');
  const unchanged = await fetch(base + avatar, {
    headers: { 'If-None-Match': `"other", ${changed.headers.get('etag')!}` },
  });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe('');
});

it('共用静态资源同样短期复用，到期只验证，缺失资源不缓存', async () => {
  const url = '/_asset/brand/fixture.txt';
  const first = await fetch(base + url);
  expect(first.headers.get('cache-control')).toBe('private, max-age=300');
  expect(await first.text()).toBe('bundled-resource');
  const unchanged = await fetch(base + url, {
    headers: { 'If-None-Match': first.headers.get('etag')! },
  });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe('');
  const missing = await fetch(base + '/_asset/brand/missing.png');
  expect(missing.status).toBe(404);
  expect(missing.headers.get('cache-control') ?? '').not.toContain('max-age');
  await missing.text();
});

it('CDN 头像按内容验证，内容变化和显式刷新不被旧验证头拦住', async () => {
  const url = '/_avatar/fetch?src=https%3A%2F%2Fexample.test%2Favatar.png';
  const first = await fetch(base + url);
  const etag = first.headers.get('etag');
  expect(etag).toBeTruthy();
  expect(await first.text()).toBe('cdn');
  const response = await fetch(base + url, { headers: { 'If-None-Match': etag! } });
  expect(response.status).toBe(304);
  expect(await response.text()).toBe('');
  mock.get.mockResolvedValue({ data: Buffer.from('changed'), contentType: 'image/png' });
  const changed = await fetch(base + url, { headers: { 'If-None-Match': etag! } });
  expect(changed.status).toBe(200);
  expect(changed.headers.get('etag')).not.toBe(etag);
  expect(await changed.text()).toBe('changed');
  const refreshed = await fetch(base + `${url}&_weq_avatar_remote=1`, {
    headers: { 'If-None-Match': changed.headers.get('etag')! },
  });
  expect(refreshed.status).toBe(200);
  expect(await refreshed.text()).toBe('changed');
  expect(mock.get).toHaveBeenLastCalledWith('https://example.test/avatar.png', 'avatar', 0);
});

it('本地缺失的 QQ 头像 CDN 回退也能返回 304，不把空响应误判为失败', async () => {
  mock.localFile.mockResolvedValue(null);
  const url = `${avatar}&fb=${encodeURIComponent('https://p.qlogo.cn/gh/123/123/100')}`;
  const first = await fetch(base + url);
  expect(await first.text()).toBe('cdn');
  const response = await fetch(base + url, {
    headers: { 'If-None-Match': first.headers.get('etag')! },
  });
  expect(response.status).toBe(304);
  expect(await response.text()).toBe('');
});

it('新鲜缓存策略不覆盖失败、业务接口和未授权响应', async () => {
  const business = await fetch(base + '/trpc/fixture');
  expect(business.headers.get('cache-control')).toBe('no-store');
  await business.text();
  mock.localFile.mockResolvedValue(null);
  const missing = await fetch(base + avatar);
  expect(missing.status).toBe(404);
  expect(missing.headers.get('cache-control') ?? '').not.toContain('max-age');
  await missing.text();
  allowed = false;
  const forbidden = await fetch(base + avatar);
  expect(forbidden.status).toBe(401);
  expect(forbidden.headers.get('cache-control') ?? '').not.toContain('max-age');
  await forbidden.text();
});

it.runIf(!!process.env.WEQ_PLAYWRIGHT_IMPORT)(
  '真实浏览器反复读取与重进页面复用头像，显式刷新单独请求',
  async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [join(__dirname, 'browser/run-avatar-cache.mjs'), base, avatar],
      { env: process.env, timeout: 30_000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({ reads: 13, refreshed: true });
    // 十二处重复使用 + 一次重进只请求一次；显式换图再请求一次。
    expect(mock.localFile).toHaveBeenCalledTimes(2);
  },
  35_000,
);
