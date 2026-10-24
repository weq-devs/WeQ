import { afterEach, expect, it, vi } from 'vitest';
import {
  createDecodedImageCache,
  DECORATION_DECODE_LIMITS,
} from '../src/renderer/src/lib/decodedImageCache';
import { readFrameBytes } from '../src/renderer/src/lib/frameImageSize';

afterEach(() => vi.unstubAllGlobals());
function pngHead(width: number, height: number) {
  const bytes = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}
it('服务端忽略 Range 时仍只取 PNG 头，并主动取消剩余响应', async () => {
  const cancel = vi.fn();
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(pngHead(256, 128));
          },
          cancel,
        }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  expect(await readFrameBytes('fixture:frame', new AbortController().signal)).toBe(256 * 128 * 4);
  expect(fetcher.mock.calls[0]?.[0]).toBe('fixture:frame');
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('异常大帧在设置 src 和调用 decode 之前拒绝，不先做真实位图分配', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(pngHead(8192, 8192))),
  );
  const decode = vi.fn(async () => {});
  const image = { src: '', naturalWidth: 0, naturalHeight: 0, decode, removeAttribute() {} };
  const cache = createDecodedImageCache(DECORATION_DECODE_LIMITS, () => image);
  await expect(cache.require('fixture:oversized')).rejects.toThrow('预算');
  expect(image.src).toBe('');
  expect(decode).not.toHaveBeenCalled();
  expect(cache.stats().reservedBytes).toBe(0);
  cache.dispose();
});
it('截断或伪造的图片头拒绝预热', async () => {
  for (const data of [new Uint8Array(2), new Uint8Array(24), pngHead(0, 1)]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(data)),
    );
    await expect(readFrameBytes('fixture:bad', new AbortController().signal)).rejects.toThrow();
  }
});
it('总字节预算包含执行中的预留，不会并发越界或淘汰在播帧', async () => {
  let finish = () => {};
  const cache = createDecodedImageCache(
    { ...DECORATION_DECODE_LIMITS, maxBytes: 4 * 1024 * 1024 },
    () => ({
      src: '',
      naturalWidth: 1024,
      naturalHeight: 1024,
      decode: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      removeAttribute() {},
    }),
  );
  const owner = cache.pin(['a']);
  const first = cache.require('a');
  await expect(cache.require('b')).rejects.toThrow('预算');
  expect(cache.stats().reservedBytes).toBe(4 * 1024 * 1024);
  finish();
  await first;
  await expect(cache.require('c')).rejects.toThrow('预算');
  expect(cache.stats().retainedBytes).toBe(4 * 1024 * 1024);
  owner.release();
  expect(cache.stats().retainedBytes).toBe(0);
  cache.dispose();
});
it('同一资源有两个使用者时，只取消一方不影响另一方；都取消才停止', async () => {
  let finish = () => {};
  const decode = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const cache = createDecodedImageCache(DECORATION_DECODE_LIMITS, () => ({
    src: '',
    naturalWidth: 1,
    naturalHeight: 1,
    decode,
    removeAttribute() {},
  }));
  const a = new AbortController(),
    b = new AbortController();
  const first = cache.require('shared', a.signal);
  const second = cache.require('shared', b.signal);
  a.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  finish();
  await expect(second).resolves.toBeUndefined();
  expect(decode).toHaveBeenCalledTimes(1);
  const c = new AbortController();
  const third = cache.require('cancelled', c.signal);
  c.abort();
  await expect(third).rejects.toMatchObject({ name: 'AbortError' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(cache.stats().totalPendingImages).toBe(0);
  finish();
  cache.dispose();
});
