import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CollectionImage } from '../src/renderer/src/components/CollectionImage';
import { collectionImageUrl } from '../src/renderer/src/lib/resourceUrl';

afterEach(() => vi.unstubAllGlobals());

it('收藏预览与原图分离，离屏移除 src，卸载断开观察器', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let notify: (entries: { isIntersecting: boolean }[]) => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof notify) {
        notify = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const original = 'https://shp.qpic.cn/collector/fixture/0';
  try {
    await act(async () =>
      root.render(createElement(CollectionImage, { originalSrc: original, alt: 'fixture' })),
    );
    expect(host.querySelector('img')?.getAttribute('src')).toBeNull();
    await act(async () => notify([{ isIntersecting: true }]));
    expect(host.querySelector('img')?.getAttribute('src')).toBe(collectionImageUrl(original, true));
    expect(collectionImageUrl(original)).not.toContain('preview=1');
    const image = host.querySelector('img')!;
    Object.defineProperty(image, 'naturalWidth', { value: 384 });
    Object.defineProperty(image, 'naturalHeight', { value: 512 });
    await act(async () => {
      image.dispatchEvent(new Event('load'));
    });
    await act(async () => notify([{ isIntersecting: false }]));
    expect(host.querySelector('img')?.getAttribute('src')).toBeNull();
    expect(image.width).toBe(384);
    expect(image.height).toBe(512);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
  expect(disconnect).toHaveBeenCalledTimes(1);
});
