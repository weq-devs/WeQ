import type { BubbleSkin } from '@weq/service';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.head.querySelector('#weq-msg-decoration')?.remove();
});

it('消息装扮预热不会一口气解码整批动画帧', async () => {
  let active = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  class FrameImage {
    src = '';
    naturalWidth = 1024;
    naturalHeight = 1024;
    removeAttribute(name: string) {
      if (name === 'src') this.src = '';
    }
    decode() {
      active++;
      peak = Math.max(peak, active);
      return new Promise<void>((resolve) =>
        releases.push(() => {
          active--;
          resolve();
        }),
      );
    }
  }
  vi.stubGlobal('Image', FrameImage);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 0;
  });
  const { injectBubbleCss } = await import('../src/renderer/src/lib/msgDecorationStyle');
  const frames = 50;
  const skin: BubbleSkin = {
    itemId: 90001,
    slice: { left: 3, right: 3, top: 3, bottom: 3 },
    imageSize: { w: 8, h: 8 },
    textColor: '#000000',
    localFile: '/synthetic/bubble.png',
    animationFrameCount: frames,
    animationFrameTimeMs: 50,
  };
  try {
    injectBubbleCss(skin);
    expect(peak).toBeLessThan(frames);
  } finally {
    for (let i = 0; i < 200; i++) {
      for (const release of releases.splice(0)) release();
      await Promise.resolve();
    }
  }
});
