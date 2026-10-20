import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDecodedImageCache,
  DECORATION_DECODE_LIMITS,
} from '../src/renderer/src/lib/decodedImageCache';

class Frame {
  src = '';
  naturalWidth = 1024;
  naturalHeight = 1024;
  decode = vi.fn(async () => {});
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}
afterEach(() => vi.useRealTimers());
describe('装扮预解码缓存', () => {
  it('按解码字节而非压缩文件大小淘汰，移除旧图源并稳定在预算内', async () => {
    const frames: Frame[] = [];
    const cache = createDecodedImageCache(DECORATION_DECODE_LIMITS, () => {
      const frame = new Frame();
      frames.push(frame);
      return frame;
    });
    for (let round = 0; round < 4; round++) {
      await Promise.all(
        Array.from({ length: 30 }, (_, i) => cache.preload(`fixture:${round}:${i}`)),
      );
      expect(cache.stats().retainedBytes).toBeLessThanOrEqual(DECORATION_DECODE_LIMITS.maxBytes);
      expect(cache.stats().activeDecodes).toBe(0);
    }
    expect(frames.filter((frame) => frame.src).length).toBe(cache.stats().retainedImages);
    expect(frames.filter((frame) => frame.src).length).toBeLessThan(frames.length);
    cache.dispose();
    expect(frames.some((frame) => frame.src)).toBe(false);
    expect(cache.stats().retainedBytes).toBe(0);
  });
  it('同时限定数量，命中会更新 LRU 且在途同 URL 不重复创建', async () => {
    const frames: Frame[] = [];
    const cache = createDecodedImageCache({ ...DECORATION_DECODE_LIMITS, maxImages: 2 }, () => {
      const frame = new Frame();
      frames.push(frame);
      return frame;
    });
    const first = cache.preload('a');
    expect(cache.preload('a')).toBe(first);
    await first;
    await cache.preload('b');
    await cache.preload('a');
    await cache.preload('c');
    expect(frames.map((frame) => frame.src)).toEqual(['a', '', 'c']);
    expect(cache.stats().retainedImages).toBe(2);
    cache.dispose();
  });
  it('并发和排队有上限，dispose 取消等待并阻止迟到结果回填', async () => {
    vi.useFakeTimers();
    const frames: Frame[] = [];
    const resolves: (() => void)[] = [];
    const limits = { ...DECORATION_DECODE_LIMITS, maxConcurrent: 2, maxPending: 3 };
    const cache = createDecodedImageCache(limits, () => {
      const frame = new Frame();
      frame.decode = vi.fn(() => new Promise<void>((resolve) => resolves.push(resolve)));
      frames.push(frame);
      return frame;
    });
    const work = Array.from({ length: 100 }, (_, i) => cache.preload(String(i)));
    expect(frames).toHaveLength(limits.maxConcurrent);
    expect(cache.stats().pendingImages).toBe(limits.maxPending);
    cache.dispose();
    await Promise.all(work);
    for (const resolve of resolves) resolve();
    await Promise.resolve();
    expect(cache.stats()).toEqual({
      retainedImages: 0,
      retainedBytes: 0,
      activeDecodes: 0,
      pendingImages: 0,
    });
    expect(frames.some((frame) => frame.src)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('超时、解码失败、超大图片都不占缓存，后续任务仍能完成', async () => {
    vi.useFakeTimers();
    let index = 0;
    const frames: Frame[] = [];
    const cache = createDecodedImageCache({ ...DECORATION_DECODE_LIMITS, maxConcurrent: 1 }, () => {
      const frame = new Frame();
      if (index === 0) frame.decode = vi.fn(() => new Promise<void>(() => {}));
      if (index === 1)
        frame.decode = vi.fn(async () => {
          throw new Error('decode failed');
        });
      if (index === 2) frame.naturalWidth = DECORATION_DECODE_LIMITS.maxBytes;
      index++;
      frames.push(frame);
      return frame;
    });
    const work = Promise.all(['timeout', 'error', 'huge', 'ok'].map((url) => cache.preload(url)));
    await vi.advanceTimersByTimeAsync(DECORATION_DECODE_LIMITS.timeoutMs);
    await work;
    expect(frames.map((frame) => frame.src)).toEqual(['', '', '', 'ok']);
    expect(cache.stats().retainedImages).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    cache.dispose();
  });
});
