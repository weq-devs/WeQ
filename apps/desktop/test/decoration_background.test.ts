import { afterEach, expect, it, vi } from 'vitest';

const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function fixture(hidden = false, pending = false) {
  const visibility = vi
    .spyOn(document, 'visibilityState', 'get')
    .mockReturnValue(hidden ? 'hidden' : 'visible');
  let reduced = false;
  const media = new EventTarget();
  Object.defineProperty(media, 'matches', { get: () => reduced });
  vi.stubGlobal('matchMedia', () => media);
  const finish: (() => void)[] = [];
  const decode = vi.fn(() =>
    pending ? new Promise<void>((resolve) => finish.push(resolve)) : Promise.resolve(),
  );
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      naturalWidth = 256;
      naturalHeight = 256;
      decode = decode;
      removeAttribute() {
        this.src = '';
      }
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 0;
  });
  const { injectWidgetCss } = await import('../src/renderer/src/lib/msgDecorationStyle');
  const { decorationImageCache } = await import('../src/renderer/src/lib/decodedImageCache');
  const flush = async () => {
    for (let i = 0; i < 80; i++) await Promise.resolve();
  };
  releases.push(() => decorationImageCache.dispose());
  // 资源凭据必须先于缓存释放。
  const release = injectWidgetCss({
    animated: true,
    itemId: 95002,
    frameCount: 4,
    frameTimeMs: 100,
    repeat: 0,
  });
  releases.unshift(release);
  return {
    decode,
    flush,
    release,
    decorationImageCache,
    finish,
    style: () => document.querySelector('[data-weq-msg-decoration]')?.textContent ?? '',
    hidden(value: boolean) {
      visibility.mockReturnValue(value ? 'hidden' : 'visible');
      document.dispatchEvent(new Event('visibilitychange'));
    },
    reduce(value: boolean) {
      reduced = value;
      media.dispatchEvent(new Event('change'));
    },
  };
}

it('文档隐藏时移除动画并释放帧，恢复预热后开播，静态外观保留且规则不累加', async () => {
  const f = await fixture();
  await f.flush();
  const original = f.style();
  expect(original).toContain('animation: weq-widgetframe-95002');
  expect(f.decorationImageCache.stats().pinnedImages).toBe(4);
  for (let i = 0; i < 5; i++) {
    f.hidden(true);
    await f.flush();
    expect(f.style()).not.toContain('animation: weq-widgetframe-95002');
    expect(f.style()).toContain('background-image:');
    expect(f.decorationImageCache.stats().retainedBytes).toBe(0);
    expect(f.decorationImageCache.stats().totalPendingImages).toBe(0);
    f.hidden(false);
    await f.flush();
    expect(f.style()).toBe(original);
    expect(f.decorationImageCache.stats().pinnedImages).toBe(4);
  }
  f.release();
  await f.flush();
  f.hidden(true);
  f.hidden(false);
  await f.flush();
  expect(f.style()).toBe('');
  expect(f.decorationImageCache.stats().retainedBytes).toBe(0);
});

it('后台初次挂载不解码；减少动态效果同样释放帧，解除后重新预热', async () => {
  const f = await fixture(true);
  await f.flush();
  expect(f.decode).not.toHaveBeenCalled();
  expect(f.style()).not.toContain('animation: weq-widgetframe-95002');
  f.hidden(false);
  await f.flush();
  expect(f.decorationImageCache.stats().pinnedImages).toBe(4);
  f.reduce(true);
  await f.flush();
  expect(f.decorationImageCache.stats().retainedBytes).toBe(0);
  expect(f.style()).not.toContain('animation: weq-widgetframe-95002');
  f.reduce(false);
  await f.flush();
  expect(f.style()).toContain('animation: weq-widgetframe-95002');
});

it('解码迟到不在后台回填，最后释放后移除可见性和媒体监听', async () => {
  const f = await fixture(false, true);
  const remove = vi.spyOn(document, 'removeEventListener');
  f.hidden(true);
  for (const finish of f.finish) finish();
  await f.flush();
  expect(f.style()).not.toContain('animation: weq-widgetframe-95002');
  expect(f.decorationImageCache.stats().retainedBytes).toBe(0);
  f.release();
  await f.flush();
  expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
});

it('生效装扮同样随文档隐藏释放帧，恢复不累加规则', async () => {
  const f = await fixture();
  f.release();
  await f.flush();
  const { applyDressSkin } = await import('../src/renderer/src/lib/dressSkin');
  releases.unshift(() => applyDressSkin(null, null, null));
  applyDressSkin(null, null, {
    animated: true,
    itemId: 95003,
    frameCount: 4,
    frameTimeMs: 100,
    repeat: 0,
  });
  await f.flush();
  const css = document.getElementById('weq-dress-skin')?.textContent;
  expect(css).toContain('animation: weq-widgetframe-95003');
  f.hidden(true);
  await f.flush();
  expect(document.getElementById('weq-dress-skin')?.textContent).not.toContain(
    'animation: weq-widgetframe-95003',
  );
  expect(f.decorationImageCache.stats().retainedBytes).toBe(0);
  f.hidden(false);
  await f.flush();
  expect(document.getElementById('weq-dress-skin')?.textContent).toBe(css);
  expect(f.decorationImageCache.stats().pinnedImages).toBe(4);
});
