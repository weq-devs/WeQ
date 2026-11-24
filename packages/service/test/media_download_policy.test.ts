import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MediaDownloadService, flushMediaDownloadLogs } from '../src/account/media_download';
import type { AccountConfigService } from '../src/account/user_config';
import { getLogger } from '../src/common/logger';
import { transferActivity } from '../src/common/managed_download';
import { updateTransferPolicy } from '../src/common/transfer_policy';
import { networkCost } from '../src/common/data_saver';

const roots: string[] = [];
afterEach(async () => {
  flushMediaDownloadLogs();
  updateTransferPolicy('auto', networkCost(false, false, 'fixture'));
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('大型聊天媒体缓存不创建任务，省流量暂缓也不等待用户继续', async () => {
  const f = await fixture();
  f.allow(true);
  const activity = vi.fn();
  transferActivity.on('state', activity);
  try {
    const bytes = 10 * 1024 * 1024;
    const image = () =>
      new Response(new Uint8Array(bytes), { headers: { 'Content-Length': String(bytes) } });
    f.fetch.mockImplementation(async () => image());
    expect(await f.service.download('large-image')).toBeTruthy();
    updateTransferPolicy('always', networkCost(false, false, 'fixture'), {
      dataSaverPrefetch: true,
      dataSaverAutoResume: false,
    });
    expect(await f.service.download('deferred-image')).toBeNull();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.external.resolveRkeys).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    updateTransferPolicy('never', networkCost(false, false, 'fixture'));
    expect(await f.service.download('manual-image', { reportActivity: true })).toBeTruthy();
    expect(activity).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: '下载聊天媒体', done: true }),
    );
  } finally {
    transferActivity.off('state', activity);
  }
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'weq-media-policy-'));
  roots.push(dir);
  let allowed = false;
  const external = {
    resolveRkeys: vi.fn<
      (
        types: number[],
        signal?: AbortSignal,
      ) => Promise<Array<{ type: number; rkey: string; createTime: number; ttlSeconds: number }>>
    >(async () => []),
  };
  const account = {
    getRecord: () => ({
      rkeys: [{ type: 10, rkey: '&rkey=synthetic', createTime: Date.now() / 1000, ttlSeconds: 60 }],
    }),
  } as unknown as AccountConfigService;
  const createService = () => new MediaDownloadService(account, dir, external, () => allowed);
  const service = createService();
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'application/octet-stream' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  return {
    dir,
    service,
    createService,
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
it('并发请求复用同一次聊天媒体下载，各自收到真实下载进度', async () => {
  const f = await fixture();
  f.allow(true);
  const upstream = Promise.withResolvers<Response>();
  f.fetch.mockReturnValueOnce(upstream.promise);
  const first = vi.fn();
  const second = vi.fn();
  const one = f.service.download('synthetic-token', {}, first);
  const two = f.service.download('synthetic-token', {}, second);
  upstream.resolve(
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
    }),
  );
  const [a, b] = await Promise.all([one, two]);
  expect(a).toBeTruthy();
  expect(b).toBe(a);
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(first).toHaveBeenLastCalledWith(3, 3);
  expect(second).toHaveBeenLastCalledWith(3, 3);
});

it('切走预览只移除其进度监听，显式保存仍共用并完成原传输', async () => {
  const f = await fixture();
  f.allow(true);
  const preview = new AbortController();
  const waiting = Promise.withResolvers<AbortSignal>();
  const body = Promise.withResolvers<Response>();
  f.fetch.mockImplementationOnce(async (_url, init) => {
    waiting.resolve(init!.signal!);
    return body.promise;
  });
  const staleProgress = vi.fn();
  const detached = f.service.download('shared', { signal: preview.signal }, staleProgress);
  const cancelled = expect(detached).rejects.toMatchObject({ name: 'AbortError' });
  const save = f.service.download('shared');
  const transport = await waiting.promise;
  const before = staleProgress.mock.calls.length;
  preview.abort();
  await cancelled;
  expect(transport.aborted).toBe(false);
  body.resolve(new Response(new Uint8Array([5, 6, 7])));
  const path = await save;
  expect(await readFile(path!)).toEqual(Buffer.from([5, 6, 7]));
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(staleProgress.mock.calls.length).toBe(before);
});

it('最后一个预览离开时停止正文，后续账号实例等待旧临时文件清理后再下载', async () => {
  const f = await fixture();
  f.allow(true);
  const preview = new AbortController();
  const received = Promise.withResolvers<void>();
  const stopped = vi.fn();
  let upstream: AbortSignal | undefined;
  f.fetch.mockImplementationOnce(async (_url, init) => {
    upstream = init?.signal ?? undefined;
    return new Response(
      new ReadableStream({
        start: (body) => body.enqueue(new Uint8Array([8])),
        cancel: stopped,
      }),
      { headers: { 'Content-Length': '4000', ETag: '"fixture"' } },
    );
  });
  const pending = f.service.download('restart', { signal: preview.signal }, (bytes) => {
    if (bytes > 0) received.resolve();
  });
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await received.promise;
  expect((await readdir(f.dir)).some((name) => name.endsWith('.part'))).toBe(true);
  preview.abort();
  const next = f.createService().download('restart');
  await cancelled;
  expect(upstream?.aborted).toBe(true);
  const path = await next;
  expect(stopped).toHaveBeenCalledOnce();
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(new Headers(f.fetch.mock.calls[1]?.[1]?.headers).get('range')).toBeNull();
  expect(await readFile(path!)).toEqual(Buffer.from([1, 2, 3]));
  expect(await readdir(f.dir)).toEqual([basename(path!)]);
});

it('取消等待外部 rkey 的最后一个调用方时不会再发下游请求', async () => {
  const f = await fixture();
  f.allow(true);
  f.fetch.mockResolvedValueOnce(new Response('missing', { status: 404 }));
  const waiting = Promise.withResolvers<AbortSignal>();
  const keys =
    Promise.withResolvers<
      Array<{ type: number; rkey: string; createTime: number; ttlSeconds: number }>
    >();
  f.external.resolveRkeys.mockImplementationOnce(async (_types, signal) => {
    waiting.resolve(signal!);
    return keys.promise;
  });
  const preview = new AbortController();
  const pending = f.service.download('abandon-fallback', { signal: preview.signal });
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const upstream = await waiting.promise;
  preview.abort();
  await cancelled;
  expect(upstream.aborted).toBe(true);
  keys.resolve([
    { type: 10, rkey: '&rkey=fixture', createTime: Date.now() / 1000, ttlSeconds: 30 },
  ]);
  expect(f.fetch).toHaveBeenCalledOnce();
});
it('小图只请求实际提供的地址，缓存可复用，体积超限不回退原图', async () => {
  const f = await fixture();
  f.allow(true);
  f.fetch.mockResolvedValueOnce(
    new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
  );
  const url = 'https://multimedia.nt.qq.com.cn/download?fileid=synthetic&spec=198';
  const path = await f.service.thumbnail(url);
  expect(path).toBeTruthy();
  expect(f.fetch).toHaveBeenCalledWith(url, expect.anything());
  expect(await f.service.thumbnail(url)).toBe(path);
  expect(f.fetch).toHaveBeenCalledOnce();
  f.fetch.mockResolvedValueOnce(
    new Response(new Uint8Array([1]), {
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(1024 * 1024) },
    }),
  );
  expect(await f.service.thumbnail(`${url}&other=1`)).toBeNull();
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.external.resolveRkeys).not.toHaveBeenCalled();
});

it('同一缩略图的相对地址与完整地址共用下载，最后一次离屏才取消', async () => {
  const f = await fixture();
  f.allow(true);
  const waiting = Promise.withResolvers<AbortSignal>();
  f.fetch.mockImplementationOnce(async (_url, init) => {
    const signal = init!.signal!;
    waiting.resolve(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const first = new AbortController();
  const second = new AbortController();
  const relative = '/download?fileid=fixture&spec=198';
  const a = expect(f.service.thumbnail(relative, false, first.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  const b = expect(
    f.service.thumbnail(`https://multimedia.nt.qq.com.cn${relative}`, false, second.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  const upstream = await waiting.promise;
  first.abort();
  await a;
  expect(upstream.aborted).toBe(false);
  second.abort();
  await b;
  expect(upstream.aborted).toBe(true);
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
