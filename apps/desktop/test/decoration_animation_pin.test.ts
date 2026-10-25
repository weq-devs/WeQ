import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const node of document.head.querySelectorAll('[data-weq-msg-decoration]')) node.remove();
});

/**
 * 频闪回归（65cb537e → 38686072）。
 *
 * 历史修复 65cb537e 的要点是「等全部帧解码完再开播 + 有人持有解码结果」；
 * 38686072 为了给内存加上限引入 LRU，淘汰时会把 `src` 摘掉 —— 正在播的 `@keyframes`
 * 于是每圈重新解码，频闪回归。
 *
 * 这里模拟首屏的规模：注入一款挂件后，再塞进远超缓存预算的可选预热，断言**已开播的
 * 帧一张都没被摘掉 src**。旧实现（无 pin）会在这里失败。
 */
it('挂件开播后，后续大量预热不会把在播的帧挤出缓存', async () => {
  const created: (FrameImage & { src: string })[] = [];
  class FrameImage {
    src = '';
    naturalWidth = 256;
    naturalHeight = 256;
    decode() {
      return Promise.resolve();
    }
    removeAttribute(name: string) {
      if (name === 'src') this.src = '';
    }
  }
  const make = () => {
    const image = new FrameImage();
    created.push(image);
    return image;
  };
  vi.stubGlobal(
    'Image',
    class {
      src: string;
      naturalWidth: number;
      naturalHeight: number;
      private inner: FrameImage;
      constructor() {
        this.inner = make();
        this.src = '';
        this.naturalWidth = this.inner.naturalWidth;
        this.naturalHeight = this.inner.naturalHeight;
        created[created.length - 1] = this as unknown as FrameImage & { src: string };
      }
      decode() {
        return this.inner.decode();
      }
      removeAttribute(name: string) {
        if (name === 'src') this.src = '';
      }
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 0;
  });

  const { injectWidgetCss } = await import('../src/renderer/src/lib/msgDecorationStyle');
  const { decorationImageCache } = await import('../src/renderer/src/lib/decodedImageCache');

  const frameCount = 20;
  const release = injectWidgetCss({
    animated: true,
    itemId: 90002,
    frameCount,
    frameTimeMs: 100,
    repeat: 0,
  });
  // 等预热与动画注入落定（每个任务一次 microtask，多引几轮足够）。
  for (let i = 0; i < 50; i++) await Promise.resolve();

  const playing = created.filter((image) => image.src.includes('dresspendant'));
  expect(playing.length).toBe(frameCount);
  // 开播的帧必须被钉住，否则下面一轮预热就能把它们淘汰掉。
  expect(decorationImageCache.stats().pinnedImages).toBeGreaterThanOrEqual(frameCount);

  // 塞远超预算的可选预热（模拟浏览装扮列表 / 其他会话的逐条装扮）。
  await Promise.all(
    Array.from({ length: 600 }, (_, i) => decorationImageCache.preload(`fixture:${i}`)),
  );

  expect(playing.filter((image) => image.src === '').length).toBe(0);
  release();
  decorationImageCache.dispose();
});
