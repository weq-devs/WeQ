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
      pinnedImages: 0,
      activeDecodes: 0,
      pendingImages: 0,
      reservedBytes: 0,
      totalPendingImages: 0,
      cancelledJobs: 0,
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

describe('在播帧不被淘汰（频闪回归）', () => {
  /**
   * 预算只放得下 3 帧的缓存，便于把「在播」与「可选预热」的取舍压到最小场景。
   * 注意 `Frame` 是 1024×1024 ≈ 4 MiB，字节预算必须跟着放大，否则单帧就超限。
   */
  const tightLimits = {
    ...DECORATION_DECODE_LIMITS,
    maxImages: 3,
    maxBytes: 3 * 4 * 1024 * 1024,
  };

  it('pin 住的帧在多轮后续预热后仍然持有图源，不被 LRU 摘掉', async () => {
    const frames = new Map<string, Frame>();
    const cache = createDecodedImageCache(tightLimits, () => {
      const frame = new Frame();
      frames.set(String(frames.size), frame);
      return frame;
    });
    const playing = ['play:1', 'play:2', 'play:3'];
    await Promise.all(playing.map((url) => cache.preload(url)));
    cache.pin(playing);

    // 模拟浏览装扮列表：一轮又一轮的可选预热，总量远超预算。
    for (let round = 0; round < 4; round++) {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => cache.preload(`browse:${round}:${i}`)),
      );
    }

    const kept = [...frames.values()]
      .filter((frame) => frame.src && playing.includes(frame.src))
      .map((frame) => frame.src)
      .sort();
    // 关键断言：正在播的三帧一张都不能被摘掉 src（摘掉就是逐帧重新解码 → 频闪）。
    expect(kept).toEqual(playing);
    cache.dispose();
  });

  it('release 之后这批帧回到普通 LRU，可以被后续预热挤出去', async () => {
    const cache = createDecodedImageCache(tightLimits, () => new Frame());
    const urls = ['a', 'b', 'c'];
    await Promise.all(urls.map((url) => cache.preload(url)));
    const owner = cache.pin(urls);
    expect(cache.stats().pinnedImages).toBe(3);
    owner.release();
    expect(cache.stats().pinnedImages).toBe(0);

    for (let round = 0; round < 3; round++) {
      await Promise.all(Array.from({ length: 5 }, (_, i) => cache.preload(`x:${round}:${i}`)));
    }
    // 未 pin 时预算照常生效，不会因为引入 pin 就把上限架空了。
    expect(cache.stats().retainedImages).toBeLessThanOrEqual(tightLimits.maxImages);
    cache.dispose();
  });

  it('同款被多处注入时靠计数：还有一份没归还就继续不淘汰', async () => {
    const cache = createDecodedImageCache(tightLimits, () => new Frame());
    await cache.preload('shared');
    const first = cache.pin(['shared']);
    const second = cache.pin(['shared']);
    first.release();
    expect(cache.stats().pinnedImages).toBe(1);
    for (let round = 0; round < 3; round++) {
      await Promise.all(Array.from({ length: 5 }, (_, i) => cache.preload(`y:${round}:${i}`)));
    }
    // 第二份凭据还在，帧应当仍被保留。
    expect(cache.stats().retainedImages).toBeGreaterThan(0);
    second.release();
    expect(cache.stats().pinnedImages).toBe(0);
    cache.dispose();
  });

  it('require 在队列超限时明确失败，不另建无界等待区；有空位后可重试', async () => {
    const releases: (() => void)[] = [];
    const limits = { ...DECORATION_DECODE_LIMITS, maxConcurrent: 1, maxPending: 1 };
    const cache = createDecodedImageCache(limits, () => {
      const frame = new Frame();
      frame.decode = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
      return frame;
    });
    let settled = false;
    // 第一个占住并发槽，第二个占满队列，第三个（必达）必须排队而不是立刻 resolve。
    void cache.preload('a');
    void cache.preload('b');
    await expect(cache.require('c')).rejects.toThrow('队列已满');
    expect(settled).toBe(false);
    expect(cache.stats().pendingImages).toBeLessThanOrEqual(limits.maxPending);
    expect(cache.stats().totalPendingImages).toBe(limits.maxConcurrent + limits.maxPending);
    releases.shift()!();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const required = cache.require('c').then(() => {
      settled = true;
    });

    // 逐个放行，直到必达任务也真正解码完成。
    for (let i = 0; i < 30 && !settled; i++) {
      for (const release of releases.splice(0)) release();
      await Promise.resolve();
      await Promise.resolve();
    }
    await required;
    expect(settled).toBe(true);
    cache.dispose();
  });

  it('require 解码失败会 reject，调用方不会误以为帧已就绪', async () => {
    const cache = createDecodedImageCache(DECORATION_DECODE_LIMITS, () => {
      const frame = new Frame();
      frame.decode = vi.fn(async () => {
        throw new Error('decode failed');
      });
      return frame;
    });
    await expect(cache.require('broken')).rejects.toThrow();
    // 可选预热对同一个 URL 仍然 silent。
    await expect(cache.preload('broken')).resolves.toBeUndefined();
    cache.dispose();
  });
});

it('先 preload 后 require 同一个 URL 时会升格成必达，失败不再假成功', async () => {
  const cache = createDecodedImageCache(DECORATION_DECODE_LIMITS, () => {
    const frame = new Frame();
    frame.decode = vi.fn(async () => {
      throw new Error('decode failed');
    });
    return frame;
  });
  // 可选预热先占住在途任务。
  void cache.preload('shared-broken');
  await expect(cache.require('shared-broken')).rejects.toThrow();
  cache.dispose();
});
