import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MediaDownloadService } from '../src/account/media_download';
import type { AccountConfigService } from '../src/account/user_config';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'weq-media-policy-'));
  roots.push(dir);
  let allowed = false;
  const external = { resolveRkeys: vi.fn(async () => []) };
  const account = {
    getRecord: () => ({
      rkeys: [{ type: 10, rkey: '&rkey=synthetic', createTime: Date.now() / 1000, ttlSeconds: 60 }],
    }),
  } as unknown as AccountConfigService;
  const service = new MediaDownloadService(account, dir, external, () => allowed);
  const fetch = vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'application/octet-stream' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  return {
    dir,
    service,
    external,
    fetch,
    allow: (value: boolean) => {
      allowed = value;
    },
  };
}
it('未允许时缓存凭据及原始 URL 都不发请求，允许后下载，关闭后本地缓存仍可读', async () => {
  const f = await fixture();
  expect(
    await f.service.download('123', { originalUrl: 'https://fixture.invalid/original' }),
  ).toBeNull();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.external.resolveRkeys).not.toHaveBeenCalled();
  f.allow(true);
  const path = await f.service.download('123');
  expect(path).toBeTruthy();
  f.allow(false);
  expect(await f.service.download('123')).toBe(path);
  expect(f.fetch).toHaveBeenCalledOnce();
});
it('请求途中失活不发布旧媒体，也不启动外部 rKey 回退或重试', async () => {
  const f = await fixture();
  f.allow(true);
  f.fetch.mockImplementationOnce(async () => {
    f.allow(false);
    return new Response('failed', { status: 503 });
  });
  expect(await f.service.download('synthetic-token')).toBeNull();
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.external.resolveRkeys).not.toHaveBeenCalled();
  expect(await readdir(f.dir)).toEqual([]);
});
it('外部凭据返回后重新校验运行态，不向新来源继续下载', async () => {
  const f = await fixture();
  f.allow(true);
  f.fetch.mockResolvedValueOnce(new Response('missing', { status: 404 }));
  f.external.resolveRkeys.mockImplementationOnce(async () => {
    f.allow(false);
    return [];
  });
  expect(await f.service.download('synthetic-token')).toBeNull();
  expect(f.fetch).toHaveBeenCalledOnce();
});
