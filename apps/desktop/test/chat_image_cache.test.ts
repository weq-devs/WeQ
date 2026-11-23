import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createChatImageCache, createChatImageUrl } from '../src/renderer/src/lib/chatImageCache';
import { remoteChatThumbnailUrl } from '../src/renderer/src/lib/cdn';
import { ChatImageCacheContext } from '../src/renderer/src/components/ChatImageCacheProvider.shared';
import { ChatImageCacheProvider } from '../src/renderer/src/components/ChatImageCacheProvider';
import { ShimmerImage } from '../src/renderer/src/components/ShimmerImage';

function preview(width = 512, height = 512) {
  const image = document.createElement('img');
  image.src = '/synthetic-preview.png';
  Object.defineProperties(image, {
    naturalWidth: { value: width },
    naturalHeight: { value: height },
  });
  return image;
}
const image = preview();
afterEach(() => vi.unstubAllGlobals());

it('Remote 只为原消息携带的匹配缩略图换用当前场景的图片票据', () => {
  const raw = '/download?appid=1406&fileid=fixture&spec=198&rkey=old';
  const state = {
    remote: true,
    enabled: true,
    rkeys: [{ type: 10, rkey: '&rkey=fresh', ttlSeconds: 30, createTime: Date.now() / 1000 }],
  };
  expect(remoteChatThumbnailUrl(state, raw, 'fixture', false)).toBe(
    'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=fixture&spec=198&rkey=fresh',
  );
  expect(remoteChatThumbnailUrl(state, raw, 'other', false)).toBeNull();
  expect(remoteChatThumbnailUrl(state, raw, 'fixture', true)).toBeNull();
  expect(remoteChatThumbnailUrl(state, raw.replace('198', '0'), 'fixture', false)).toBeNull();
  expect(remoteChatThumbnailUrl({ ...state, enabled: false }, raw, 'fixture', false)).toBeNull();
});

it('缓存只保留独立图片，不持有 React 节点、事件闭包或父树，淘汰时释放资源', () => {
  const original = preview();
  Object.assign(original, { __reactFiber: { retainedTree: {} } });
  original.onload = vi.fn();
  const create = vi.spyOn(document, 'createElement');
  const cache = createChatImageCache(1);
  try {
    cache.remember('one', original);
    expect(create).toHaveBeenCalledWith('img');
    const retained = create.mock.results.find((result) => result.value.tagName === 'IMG')!
      .value as HTMLImageElement;
    expect(retained).not.toBe(original);
    expect(retained.src).toBe(original.src);
    expect('__reactFiber' in retained).toBe(false);
    expect(retained.onload).toBeNull();
    create.mockClear();
    cache.remember('one', original);
    expect(create).not.toHaveBeenCalled();
    cache.clear();
    expect(retained.hasAttribute('src')).toBe(false);
    expect(original.hasAttribute('src')).toBe(true);
  } finally {
    create.mockRestore();
  }
});

it('直取图片随缓存保留对象地址，最后一方释放才回收', () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/image');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  try {
    const data = new Blob(['image'], { type: 'image/png' });
    const asset = createChatImageUrl(data);
    const release = asset.retain();
    const cache = createChatImageCache(1);
    const node = preview(32, 32);
    node.src = asset.src;
    cache.remember('direct', node, asset);
    release();
    expect(revoke).not.toHaveBeenCalled();
    expect(cache.source('direct')).toBe(asset.src);
    cache.remember('direct', node);
    expect(cache.stats().bytes).toBe(32 * 32 * 4 + data.size);
    cache.clear();
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(asset.src);
  } finally {
    create.mockRestore();
    revoke.mockRestore();
  }
});

it('按最近查看顺序淘汰，重复资源只计算一次；可见资源受保护，离屏后重新收敛', () => {
  const cache = createChatImageCache(2);
  cache.remember('a', image);
  cache.remember('b', image);
  const release = cache.activate('a');
  release();
  release();
  cache.remember('c', image);
  expect(cache.has('a')).toBe(true);
  expect(cache.has('b')).toBe(false);
  cache.remember('c', image);
  expect(cache.stats().images).toBe(2);
  expect(cache.stats().bytes).toBe(2 * 1024 * 1024);
  const first = cache.activate('a');
  const second = cache.activate('a');
  cache.setBudgetMiB(1);
  cache.remember('d', image);
  expect(cache.has('d')).toBe(false);
  first();
  cache.remember('d', image);
  expect(cache.has('a')).toBe(true);
  second();
  cache.remember('d', image);
  expect(cache.has('a')).toBe(false);
  expect(cache.stats().bytes).toBeLessThanOrEqual(cache.stats().limit);
});

it('预算缩小、关闭和清空立即生效，异常尺寸与超大单图不会进入保留缓存', () => {
  const cache = createChatImageCache(2);
  cache.remember('a', image);
  const release = cache.activate('a');
  cache.setBudgetMiB(0);
  expect(cache.has('a')).toBe(false);
  cache.remember('a', image);
  expect(cache.stats().bytes).toBe(0);
  release();
  cache.setBudgetMiB(1);
  cache.remember('large', preview(4096, 4096));
  cache.remember('broken', preview(0, 0));
  cache.remember('invalid', preview(Number.MAX_VALUE, 9));
  expect(cache.stats().images).toBe(0);
  cache.remember('a', image);
  cache.clear();
  expect(cache.stats().images).toBe(0);
});

it('大量小图也有数量边界；可见图片超额时不清空，离屏后回落到预算', () => {
  const cache = createChatImageCache(1);
  for (let i = 0; i < 600; i++) cache.remember(String(i), preview(1, 1));
  expect(cache.stats().images).toBeLessThan(600);
  cache.clear();
  const a = cache.activate('a');
  const b = cache.activate('b');
  cache.remember('a', image);
  cache.remember('b', image);
  expect(cache.stats().bytes).toBe(2 * 1024 * 1024);
  a();
  expect(cache.has('a')).toBe(false);
  expect(cache.has('b')).toBe(true);
  b();
});

it('加载期间只有图形占位；预算内离屏不移除源，淘汰后仍有稳定占位和尺寸', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let notify = (_visible: boolean) => {};
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect() {}
      observe() {}
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        notify = (visible) => callback([{ isIntersecting: visible }]);
      }
    },
  );
  const cache = createChatImageCache(1);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(
          ChatImageCacheContext.Provider,
          { value: cache },
          h(ShimmerImage, { suspendOffscreen: true, src: '/fixture.png', alt: '[图片]' }),
        ),
      ),
    );
    let img = host.querySelector('img')!;
    expect(img.style.opacity).toBe('0');
    expect(host.querySelector('.weq-image-placeholder svg')).not.toBeNull();
    expect(host.textContent).toBe('');
    act(() => notify(true));
    img = host.querySelector('img')!;
    Object.defineProperties(img, { naturalWidth: { value: 512 }, naturalHeight: { value: 512 } });
    act(() => img.dispatchEvent(new Event('load')));
    act(() => notify(false));
    expect(host.querySelector('img')).toBe(img);
    expect(img.getAttribute('src')).toBe('/fixture.png');
    act(() => cache.remember('new', image));
    img = host.querySelector('img')!;
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.style.opacity).toBe('0');
    expect(img.width).toBe(512);
    expect(img.height).toBe(512);
    expect(host.querySelector('.weq-image-placeholder svg')).not.toBeNull();
    act(() => notify(true));
    img = host.querySelector('img')!;
    Object.defineProperties(img, {
      naturalWidth: { value: 512 },
      naturalHeight: { value: 512 },
      complete: { value: true },
    });
    act(() => img.dispatchEvent(new Event('load')));
    act(() => cache.setBudgetMiB(0));
    expect(img.getAttribute('src')).toBe('/fixture.png');
    act(() => cache.setBudgetMiB(1));
    act(() => notify(false));
    expect(host.querySelector('img')).toBe(img);
    expect(img.getAttribute('src')).toBe('/fixture.png');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('切换账号清空旧资源，虚拟列表卸载不丢缓存，预算更新无需重启', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (scope: string, budget: number, show = true) =>
    act(() =>
      root.render(
        h(
          ChatImageCacheProvider,
          { scope, budgetMiB: budget },
          show ? h(ShimmerImage, { suspendOffscreen: true, src: '/fixture.png' }) : null,
        ),
      ),
    );
  try {
    render('one', 1);
    const img = host.querySelector('img')!;
    Object.defineProperties(img, { naturalWidth: { value: 512 }, naturalHeight: { value: 512 } });
    act(() => img.dispatchEvent(new Event('load')));
    render('one', 1, false);
    // DOM 不在视口，只有缓存保留项才能让重新挂载的图片取得 src。
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    render('one', 1);
    expect(host.querySelector('img')!.hasAttribute('src')).toBe(true);
    render('one', 0);
    expect(host.querySelector('img')!.hasAttribute('src')).toBe(false);
    render('two', 1);
    expect(host.querySelector('img')!.hasAttribute('src')).toBe(false);
  } finally {
    act(() => root.unmount());
  }
});

it('Remote 缩略图优先复用手机缓存，手机直取失败后使用电脑地址', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  const postMessage = vi
    .fn()
    .mockResolvedValueOnce({ type: 'image/png', base64: 'Zml4dHVyZQ==' })
    .mockRejectedValueOnce(new Error('CDN unavailable'));
  vi.stubGlobal('webkit', { messageHandlers: { weqQqImage: { postMessage } } });
  const cache = createChatImageCache(1);
  const host = document.createElement('div');
  const root = createRoot(host);
  const thumbnail =
    'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=fixture&spec=198&rkey=fixture';
  const render = (src?: string) =>
    act(async () =>
      root.render(
        h(
          ChatImageCacheContext.Provider,
          { value: cache },
          src ? h(ShimmerImage, { src, suspendOffscreen: true, remoteImageSrc: thumbnail }) : null,
        ),
      ),
    );
  try {
    await render('/first.jpg');
    const img = host.querySelector('img')!;
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    Object.defineProperties(img, { naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
    act(() => img.dispatchEvent(new Event('load')));
    await render();
    await render('/first.jpg');
    expect(host.querySelector('img')?.getAttribute('src')).toBe(img.getAttribute('src'));
    expect(postMessage).toHaveBeenCalledTimes(1);
    await render('/second.jpg');
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/second.jpg');
  } finally {
    act(() => root.unmount());
  }
});
