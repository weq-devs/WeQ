// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withNetworkTransport } from '@weq/network';
import { networkScope } from '@weq/service/network-scope';
import { videoPreviewResponse } from '../src/main/video_preview_response';

let root = '';
let path = '';
const video = Buffer.from('0000ftypisom0000synthetic-video-data');
const url = 'https://fixture.invalid/video.mp4';
const request = (headers?: HeadersInit, signal?: AbortSignal) =>
  new Request('weq-media://video?token=synthetic', { headers, signal });
const response = (bytes = video, headers: HeadersInit = {}, status = 200) => {
  const merged = new Headers({
    'Content-Type': 'video/mp4',
    'Content-Length': String(bytes.length),
  });
  new Headers(headers).forEach((value, key) => {
    merged.set(key, value);
  });
  return new Response(bytes, {
    status,
    headers: merged,
  });
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'weq-stream-video-'));
  path = join(root, 'cached.mp4');
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

it('首段立即交给播放器，不等待原片结束；完整收取后才发布缓存', async () => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream({
          start: (value) => {
            upstream = value;
          },
        }),
        {
          headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.length) },
        },
      ),
  );
  const out = await withNetworkTransport(fetcher, () => videoPreviewResponse(url, path, request()));
  const reader = out.body!.getReader();
  upstream.enqueue(video.subarray(0, 16));
  expect(Buffer.from((await reader.read()).value!)).toEqual(video.subarray(0, 16));
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  upstream.enqueue(video.subarray(16));
  upstream.close();
  expect(Buffer.from((await reader.read()).value!)).toEqual(video.subarray(16));
  expect((await reader.read()).done).toBe(true);
  expect(await readFile(path)).toEqual(video);
  expect(await readdir(root)).toEqual(['cached.mp4']);
});

it('显式保存视频仅返回数据流，不再生成预览缓存', async () => {
  const out = await withNetworkTransport(
    async () => response(),
    () => videoPreviewResponse(url, path, request(), undefined, false),
  );
  expect(Buffer.from(await out.arrayBuffer())).toEqual(video);
  expect(await readdir(root)).toEqual([]);
});

it.each(['bytes=16-23', 'bytes=-8'])(
  '转发拖动或尾部范围 %s，局部响应不写完整缓存',
  async (range) => {
    const bytes = video.subarray(16, 24);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('range')).toBe(range);
      expect(headers.get('if-range')).toBe('"fixture"');
      return response(
        bytes,
        { 'Content-Range': `bytes 16-23/${video.length}`, 'Accept-Ranges': 'bytes' },
        206,
      );
    });
    const out = await withNetworkTransport(fetcher, () =>
      videoPreviewResponse(url, path, request({ Range: range, 'If-Range': '"fixture"' })),
    );
    expect(out.status).toBe(206);
    expect(out.headers.get('content-range')).toBe(`bytes 16-23/${video.length}`);
    expect(Buffer.from(await out.arrayBuffer())).toEqual(bytes);
    expect(await readdir(root)).toEqual([]);
  },
);

it('bytes=0- 返回整片 206 时仍可完成缓存', async () => {
  const out = await withNetworkTransport(
    async () =>
      response(video, { 'Content-Range': `bytes 0-${video.length - 1}/${video.length}` }, 206),
    () => videoPreviewResponse(url, path, request({ Range: 'bytes=0-' })),
  );
  expect(out.status).toBe(206);
  await out.arrayBuffer();
  expect(await readFile(path)).toEqual(video);
});

it('上游忽略 Range 返回 200 时保留真实状态，不伪造局部响应', async () => {
  const out = await withNetworkTransport(
    async () => response(),
    () => videoPreviewResponse(url, path, request({ Range: 'bytes=12-' })),
  );
  expect(out.status).toBe(200);
  expect(out.headers.has('content-range')).toBe(false);
  expect(Buffer.from(await out.arrayBuffer())).toEqual(video);
});

it('越界范围保留 416 和总长，不尝试整片回退', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${video.length}`, 'Content-Length': '123' },
      }),
  );
  const out = await withNetworkTransport(fetcher, () =>
    videoPreviewResponse(url, path, request({ Range: 'bytes=9999-' })),
  );
  expect(out.status).toBe(416);
  expect(out.headers.has('content-length')).toBe(false);
  expect(out.headers.get('content-range')).toBe(`bytes */${video.length}`);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('关闭预览取消上游并清掉半片，不等待原片下载结束', async () => {
  const cancel = vi.fn();
  let signal: AbortSignal | undefined;
  const out = await withNetworkTransport(
    async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start: (value) => value.enqueue(video.subarray(0, 16)),
          cancel,
        }),
        { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.length) } },
      );
    },
    () => videoPreviewResponse(url, path, request()),
  );
  const reader = out.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(cancel).toHaveBeenCalled();
  expect(signal?.aborted).toBe(true);
  expect(await readdir(root)).toEqual([]);
});

it('拖动后复用已读片段，开放区间校验版本再只请求剩余部分', async () => {
  const sample = Buffer.concat([video, Buffer.alloc(128 * 1024, 17)]);
  const tag = '"stable-video"';
  const client = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const header = new Headers(init?.headers);
    if (header.get('range') === 'bytes=8-') {
      return new Response(
        new ReadableStream({ start: (stream) => stream.enqueue(sample.subarray(8, 96 * 1024)) }),
        {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': String(sample.length - 8),
            'Content-Range': `bytes 8-${sample.length - 1}/${sample.length}`,
            ETag: tag,
          },
        },
      );
    }
    expect(header.get('range')).toBe(`bytes=${96 * 1024}-${sample.length - 1}`);
    expect(header.get('if-range')).toBe(tag);
    return response(
      sample.subarray(96 * 1024),
      {
        'Content-Range': `bytes ${96 * 1024}-${sample.length - 1}/${sample.length}`,
        ETag: tag,
      },
      206,
    );
  });
  await withNetworkTransport(fetcher, async () => {
    const first = await videoPreviewResponse(
      url,
      path,
      request({ Range: 'bytes=8-' }, client.signal),
    );
    const read = first.body!.getReader();
    expect(Buffer.from((await read.read()).value!)).toEqual(sample.subarray(8, 96 * 1024));
    client.abort();
    await read.cancel();

    const hit = await networkScope.run({ restricted: true, intent: 'prefetch' }, () =>
      videoPreviewResponse(url, path, request({ Range: 'bytes=10-17' })),
    );
    expect(hit.headers.get('cache-control')).toBe('no-store');
    expect(hit.headers.get('content-range')).toBe(`bytes 10-17/${sample.length}`);
    expect(Buffer.from(await hit.arrayBuffer())).toEqual(sample.subarray(10, 18));
    expect(fetcher).toHaveBeenCalledOnce();

    const resumed = await videoPreviewResponse(url, path, request({ Range: 'bytes=8-' }));
    expect(resumed.headers.get('content-range')).toBe(
      `bytes 8-${sample.length - 1}/${sample.length}`,
    );
    expect(Buffer.from(await resumed.arrayBuffer())).toEqual(sample.subarray(8));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await readdir(root)).toEqual([]);
  });
});

it('跨版本续接失败时按原 Range 重试，并丢弃上一版片段', async () => {
  const sample = Buffer.concat([video, Buffer.alloc(128 * 1024, 17)]);
  const updated = Buffer.concat([video, Buffer.alloc(128 * 1024, 29)]);
  const oldTag = '"old"';
  const newTag = '"new"';
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const header = new Headers(init?.headers);
    switch (header.get('range')) {
      case 'bytes=0-65535':
        return response(
          sample.subarray(0, 64 * 1024),
          {
            'Content-Range': `bytes 0-65535/${sample.length}`,
            ETag: oldTag,
          },
          206,
        );
      case `bytes=65536-${sample.length - 1}`:
        expect(header.get('if-range')).toBe(oldTag);
        return response(updated, { ETag: newTag });
      default:
        expect(header.get('range')).toBe('bytes=0-');
        expect(header.has('if-range')).toBe(false);
        return response(
          updated,
          {
            'Content-Range': `bytes 0-${sample.length - 1}/${sample.length}`,
            ETag: newTag,
          },
          206,
        );
    }
  });
  await withNetworkTransport(fetcher, async () => {
    const initial = await videoPreviewResponse(url, path, request({ Range: 'bytes=0-65535' }));
    await initial.arrayBuffer();
    const fresh = await videoPreviewResponse(url, path, request({ Range: 'bytes=0-' }));
    expect(fresh.headers.get('etag')).toBe(newTag);
    expect(Buffer.from(await fresh.arrayBuffer()).equals(updated)).toBe(true);
    expect((await readFile(path)).equals(updated)).toBe(true);
    const hit = await videoPreviewResponse(url, path, request({ Range: 'bytes=0-65535' }));
    expect(hit.headers.get('etag')).toBe(newTag);
    expect(Buffer.from(await hit.arrayBuffer()).equals(updated.subarray(0, 64 * 1024))).toBe(true);
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('片段遵循上游 no-store 和新鲜期，显式保存仍现取上游字节', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(async () => {
    const headers = {
      'Content-Range': `bytes 8-15/${video.length}`,
      'Cache-Control': fetcher.mock.calls.length === 1 ? 'no-store' : 'max-age=1',
      ETag: '"fixture"',
    };
    return response(video.subarray(8, 16), headers, 206);
  });
  await withNetworkTransport(fetcher, async () => {
    const play = async (cache = true) => {
      const out = await videoPreviewResponse(
        url,
        path,
        request({ Range: 'bytes=8-15' }),
        undefined,
        cache,
      );
      expect(Buffer.from(await out.arrayBuffer())).toEqual(video.subarray(8, 16));
    };
    await play();
    await play();
    await play();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await play(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1001);
    await play();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

it('请求在响应头前取消，会中止等待首字节', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const work = withNetworkTransport(fetcher, () =>
    videoPreviewResponse(url, path, request(undefined, controller.signal)),
  );
  const rejected = expect(work).rejects.toThrow('closed');
  controller.abort(new Error('closed'));
  await rejected;
});

it('上游断流或长度不符不发布缓存', async () => {
  const out = await withNetworkTransport(
    async () => response(video.subarray(0, 16), { 'Content-Length': String(video.length) }),
    () => videoPreviewResponse(url, path, request()),
  );
  await expect(out.arrayBuffer()).rejects.toThrow('不完整');
  expect(await readdir(root)).toEqual([]);
});

it('错误页面不交给播放器，伪装成二进制也不缓存', async () => {
  const cancel = vi.fn();
  const out = await withNetworkTransport(
    async () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { 'Content-Type': 'text/html' },
      }),
    () => videoPreviewResponse(url, path, request()),
  );
  expect(out.status).toBe(502);
  expect(cancel).toHaveBeenCalledOnce();
  const disguised = await withNetworkTransport(
    async () => response(Buffer.from('<html>expired</html>')),
    () => videoPreviewResponse(url, path, request()),
  );
  await expect(disguised.arrayBuffer()).rejects.toThrow('格式不符');
  expect(await readdir(root)).toEqual([]);
});

it('缓存目标已有其他内容时不覆盖，播放器仍收到当前原片', async () => {
  await writeFile(path, 'existing');
  const out = await withNetworkTransport(
    async () => response(),
    () => videoPreviewResponse(url, path, request()),
  );
  expect(Buffer.from(await out.arrayBuffer())).toEqual(video);
  expect(await readFile(path, 'utf8')).toBe('existing');
  expect(await readdir(root)).toEqual(['cached.mp4']);
});

it('省流量模式不自动拉取缺失原片', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const out = await withNetworkTransport(fetcher, () =>
    networkScope.run({ restricted: true, intent: 'prefetch' }, () =>
      videoPreviewResponse(url, path, request()),
    ),
  );
  expect(out.status).toBe(409);
  expect(fetcher).not.toHaveBeenCalled();
});

it('切换账号后停止消费与缓存旧来源', async () => {
  let current = true;
  const cancel = vi.fn();
  const out = await withNetworkTransport(
    async () =>
      new Response(
        new ReadableStream({
          start: (value) => value.enqueue(video),
          cancel,
        }),
        { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.length) } },
      ),
    () =>
      videoPreviewResponse(url, path, request(), () => {
        if (!current) throw new Error('来源已切换');
      }),
  );
  current = false;
  await expect(out.arrayBuffer()).rejects.toThrow('来源已切换');
  expect(cancel).toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

it('首字节和停滞正文都有期限，不把持续播放误当总时限超时', async () => {
  vi.useFakeTimers();
  const work = withNetworkTransport(
    () => new Promise(() => {}),
    () => videoPreviewResponse(url, path, request()),
  );
  const rejected = expect(work).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  const out = await withNetworkTransport(
    async () =>
      new Response(new ReadableStream({}), {
        headers: { 'Content-Type': 'video/mp4' },
      }),
    () => videoPreviewResponse(url, path, request()),
  );
  const stalled = expect(out.arrayBuffer()).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(30_000);
  await stalled;
});
