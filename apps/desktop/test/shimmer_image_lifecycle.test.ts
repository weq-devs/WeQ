import { act, createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ShimmerImage } from '../src/renderer/src/components/ShimmerImage';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { useDataSaver } from '../src/renderer/src/lib/dataSaver';
import { thumbnailPolicyRequest } from '../src/renderer/src/lib/resourceUrl';

const initialPolicy = useDataSaver.getState();
afterEach(() => {
  useDataSaver.setState(initialPolicy);
  vi.unstubAllGlobals();
});

it('无关下载设置不重挂缩略图，聊天参数、外站 URL 和主动意图保持原样', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useDataSaver.setState({ enabled: true });
  for (const src of [
    'weq-media://pic?recv=1&cacheOnly=1&v=thumb&intent=interactive',
    'https://other.invalid/_media/album?ds=1&src=fixture',
    'data:image/png;base64,fixture',
  ])
    expect(thumbnailPolicyRequest(src)).toEqual({ src, policyKey: '' });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(h(ShimmerImage, { src: 'weq-media://album?src=fixture' })));
    const image = host.querySelector('img')!;
    act(() => image.dispatchEvent(new Event('load')));
    act(() =>
      useDataSaver.setState({
        behavior: { ...useDataSaver.getState().behavior, dataSaverLargeMiB: 50 },
      }),
    );
    expect(host.querySelector('img')).toBe(image);
    expect(host.querySelector('.weq-image-placeholder')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it('省流量下未加载的相册图保留静态占位，解除限制后恢复请求且旧事件不串源', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useDataSaver.setState({ enabled: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  const error = vi.fn();
  try {
    act(() =>
      root.render(
        h(ShimmerImage, {
          src: 'weq-media://album?src=https%3A%2F%2Fugc.qpic.cn%2Ffixture&ds=1',
          alt: '精选图片',
          onError: error,
        }),
      ),
    );
    const deferred = host.querySelector('img')!;
    act(() => deferred.dispatchEvent(new Event('error')));
    expect(deferred.style.opacity).toBe('0');
    expect(host.querySelector('.weq-shimmer-block')).toBeNull();
    expect(host.querySelector('.weq-image-placeholder')?.getAttribute('aria-label')).toBe(
      '精选图片未加载（省流量模式）',
    );
    act(() => useDataSaver.setState({ enabled: false }));
    const current = host.querySelector('img')!;
    expect(new URL(current.src).searchParams.has('ds')).toBe(false);
    expect(current).not.toBe(deferred);
    act(() => deferred.dispatchEvent(new Event('error')));
    expect(error).toHaveBeenCalledOnce();
    act(() => current.dispatchEvent(new Event('load')));
    expect(host.querySelector('.weq-image-placeholder')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it('省流量允许装扮后重试失败图片，不把主动预览降回自动请求', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useDataSaver.setState({ enabled: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(ShimmerImage, {
          src: 'weq-media://dress?src=https%3A%2F%2Ftianquan.gtimg.cn%2Ffixture&ds=1&intent=interactive',
        }),
      ),
    );
    const previous = host.querySelector('img')!;
    act(() => previous.dispatchEvent(new Event('error')));
    act(() =>
      useDataSaver.setState({
        behavior: { ...useDataSaver.getState().behavior, dataSaverDress: true },
      }),
    );
    const current = host.querySelector('img')!;
    expect(current).not.toBe(previous);
    expect(new URL(current.src).searchParams.get('intent')).toBe('interactive');
    expect(host.querySelector('.weq-shimmer-block')).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it('快速离屏再恢复后，旧加载的迟到事件不能污染当前图片', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let notify = (_visible: boolean) => {};
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        notify = (visible) => callback([{ isIntersecting: visible }]);
      }
    },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const error = vi.fn();
  const load = vi.fn();
  try {
    act(() =>
      root.render(
        h(ShimmerImage, {
          src: '/fixture.png',
          suspendOffscreen: true,
          onError: error,
          onLoad: load,
        }),
      ),
    );
    act(() => notify(true));
    const previous = host.querySelector('img')!;
    act(() => notify(false));
    const suspended = host.querySelector('img')!;
    act(() => notify(true));
    const current = host.querySelector('img')!;
    act(() => {
      previous.dispatchEvent(new Event('error'));
      suspended.dispatchEvent(new Event('error'));
      previous.dispatchEvent(new Event('load'));
    });
    expect(error).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(current.getAttribute('src')).toBe('/fixture.png');
    expect(host.querySelector('.weq-shimmer-block')).not.toBeNull();
    act(() => current.dispatchEvent(new Event('load')));
    expect(load).toHaveBeenCalledOnce();
    expect(host.querySelector('.weq-shimmer-block')).toBeNull();
    act(() => current.dispatchEvent(new Event('error')));
    expect(error).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('离屏、隐藏标签和隐藏文档释放图片源，恢复时不丢尺寸或触发失败回退', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const observers: Array<{ notify(visible: boolean): void; disconnect: ReturnType<typeof vi.fn> }> =
    [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        observers.push({
          notify: (visible) => callback([{ isIntersecting: visible }]),
          disconnect: this.disconnect,
        });
      }
    },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const error = vi.fn();
  const render = (active: boolean) =>
    act(() =>
      root.render(
        h(
          StrictMode,
          null,
          h(
            TabActivity,
            { active },
            h(ShimmerImage, {
              src: '/fixture.png',
              srcSet: '/fixture-2.png 2x',
              suspendOffscreen: true,
              onError: error,
            }),
          ),
        ),
      ),
    );
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  visibility.mockReturnValue('visible');
  try {
    render(true);
    let image = host.querySelector('img')!;
    expect(image.hasAttribute('src')).toBe(false);
    expect(image.hasAttribute('srcset')).toBe(false);
    act(() => observers.at(-1)!.notify(true));
    image = host.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/fixture.png');
    Object.defineProperties(image, { naturalWidth: { value: 640 }, naturalHeight: { value: 480 } });
    act(() => image.dispatchEvent(new Event('load')));
    act(() => observers.at(-1)!.notify(false));
    image = host.querySelector('img')!;
    expect(image.hasAttribute('src')).toBe(false);
    expect(image.width).toBe(640);
    expect(image.height).toBe(480);
    act(() => image.dispatchEvent(new Event('error')));
    expect(error).not.toHaveBeenCalled();
    act(() => observers.at(-1)!.notify(true));
    render(false);
    image = host.querySelector('img')!;
    expect(image.hasAttribute('src')).toBe(false);
    render(true);
    act(() => observers.at(-1)!.notify(true));
    image = host.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/fixture.png');
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    image = host.querySelector('img')!;
    expect(image.hasAttribute('src')).toBe(false);
    act(() => observers.at(-1)!.notify(true));
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    image = host.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/fixture.png');
    act(() => image.dispatchEvent(new Event('error')));
    expect(error).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    host.remove();
    visibility.mockRestore();
  }
  expect(observers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
});

it('不启用离屏释放时保留原有图片行为', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(h(ShimmerImage, { src: '/fixture.png' })));
    expect(host.querySelector('img')!.getAttribute('src')).toBe('/fixture.png');
  } finally {
    act(() => root.unmount());
  }
});

it('换源与 srcSet 更新隔离旧事件，当前源失败仍可正常回退', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const error = vi.fn();
  const render = (src: string, srcSet?: string) =>
    act(() => root.render(h(ShimmerImage, { src, srcSet, onError: error })));
  try {
    render('/first.png');
    const first = host.querySelector('img')!;
    act(() => first.dispatchEvent(new Event('load')));
    render('/second.png');
    const second = host.querySelector('img')!;
    expect(host.querySelector('.weq-shimmer-block')).not.toBeNull();
    act(() => first.dispatchEvent(new Event('error')));
    expect(error).not.toHaveBeenCalled();
    render('/second.png', '/second-2x.png 2x');
    act(() => second.dispatchEvent(new Event('error')));
    expect(error).not.toHaveBeenCalled();
    act(() => host.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(error).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

it('没有 IntersectionObserver 时仍遵守文档可见性和显式尺寸', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(ShimmerImage, { src: '/fallback.png', suspendOffscreen: true, width: 80, height: 60 }),
      ),
    );
    let image = host.querySelector('img')!;
    expect(image.hasAttribute('src')).toBe(false);
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    image = host.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/fallback.png');
    Object.defineProperties(image, { naturalWidth: { value: 640 }, naturalHeight: { value: 480 } });
    act(() => image.dispatchEvent(new Event('load')));
    expect(image.width).toBe(80);
    expect(image.height).toBe(60);
  } finally {
    act(() => root.unmount());
    visibility.mockRestore();
  }
});
