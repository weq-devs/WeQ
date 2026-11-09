import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MediaDownloadService, flushMediaDownloadLogs } from '../src/account/media_download';
import type { AccountConfigService } from '../src/account/user_config';
import { getLogger } from '../src/common/logger';

const roots: string[] = [];
afterEach(async () => {
  flushMediaDownloadLogs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'weq-media-policy-'));
  roots.push(dir);
  let allowed = false;
  const external = {
    resolveRkeys: vi.fn<
      () => Promise<Array<{ type: number; rkey: string; createTime: number; ttlSeconds: number }>>
    >(async () => []),
  };
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
it('缓存命中与逐图成功只记 debug，批量来源按短窗口汇总且没有凭据', async () => {
  const info = vi.spyOn(getLogger(), 'info');
  const debug = vi.fn(),
    warn = vi.fn();
  vi.spyOn(getLogger(), 'child').mockReturnValue({
    debug,
    warn,
    error: vi.fn(),
    info: vi.fn(),
    child: vi.fn(),
  });
  const f = await fixture();
  f.allow(true);
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(5000);
  info.mockClear();
  await f.service.download('synthetic-secret-token');
  await f.service.download('synthetic-secret-token');
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(info).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(info).toHaveBeenCalledWith(
    '媒体下载汇总',
    expect.objectContaining({ source: 'local-rkey', count: 1, failed: 0 }),
  );
  expect(
    JSON.stringify([...debug.mock.calls, ...info.mock.calls, ...warn.mock.calls]),
  ).not.toContain('synthetic-secret-token');
});
it('本机失败后外部 rkey 成功，所有来源失败保留阶段摘要，中途禁用不告警', async () => {
  const debug = vi.fn(),
    warn = vi.fn();
  vi.spyOn(getLogger(), 'child').mockReturnValue({
    debug,
    warn,
    error: vi.fn(),
    info: vi.fn(),
    child: vi.fn(),
  });
  const f = await fixture();
  f.allow(true);
  f.external.resolveRkeys.mockResolvedValue([
    { type: 10, rkey: '&rkey=external-private', createTime: Date.now() / 1000, ttlSeconds: 60 },
  ]);
  f.fetch.mockResolvedValueOnce(new Response('missing', { status: 404 }));
  expect(await f.service.download('external-token')).toBeTruthy();
  expect(debug).toHaveBeenCalledWith(
    'downloaded media into cache',
    expect.objectContaining({ source: 'external-rkey' }),
  );
  f.fetch.mockImplementation(async () => new Response('missing', { status: 404 }));
  expect(await f.service.download('failed-token')).toBeNull();
  expect(warn).toHaveBeenCalledWith(
    'media download exhausted all candidates',
    expect.objectContaining({
      failures: { 'local-rkey:http-404': 1, 'external:http-404': 1 },
      externalCandidateCount: 1,
    }),
  );
  warn.mockClear();
  f.fetch.mockImplementationOnce(async () => {
    f.allow(false);
    return new Response('missing', { status: 404 });
  });
  expect(await f.service.download('cancelled-token')).toBeNull();
  expect(warn).not.toHaveBeenCalled();
  const logs = JSON.stringify([...debug.mock.calls, ...warn.mock.calls]);
  expect(logs).not.toContain('external-private');
  expect(logs).not.toContain('failed-token');
});
