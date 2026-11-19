import { afterEach, expect, it, vi } from 'vitest';

const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.useRealTimers();
});

async function fixture(hidden = false, pending = false, failure?: () => unknown) {
  const visibility = vi
    .spyOn(document, 'visibilityState', 'get')
    .mockReturnValue(hidden ? 'hidden' : 'visible');
  let reduced = false;
  const media = new EventTarget();
  Object.defineProperty(media, 'matches', { get: () => reduced });
  vi.stubGlobal('matchMedia', () => media);
  const finish: (() => void)[] = [];
  const decode = vi.fn(() => {
    const error = failure?.();
    if (error) return Promise.reject(error);
    return pending ? new Promise<void>((resolve) => finish.push(resolve)) : Promise.resolve();
  });
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

it.each(['timer', 'online'])('临时帧失败后通过 %s 有界恢复，静态外观不消失', async (trigger) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let available = false;
  const f = await fixture(false, false, () => !available && new TypeError('网络暂不可达'));
  await f.flush();
  expect(f.style()).not.toContain('animation: weq-widgetframe-95002');
  expect(f.style()).toContain('background-image:');
  available = true;
  if (trigger === 'online') window.dispatchEvent(new Event('online'));
  else await vi.advanceTimersByTimeAsync(1000);
  await f.flush();
  expect(f.style()).toContain('animation: weq-widgetframe-95002');
  expect(f.decorationImageCache.stats().pinnedImages).toBe(4);
  expect(vi.getTimerCount()).toBe(0);
});

it('持续失败最多重试两次，隐藏和卸载取消等待，不在后台恢复动画', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = await fixture(false, false, () => new TypeError('网络暂不可达'));
  await f.flush();
  const firstAttempts = f.decode.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  await f.flush();
  expect(f.decode).toHaveBeenCalledTimes(firstAttempts * 3);
  window.dispatchEvent(new Event('online'));
  await f.flush();
  expect(f.decode).toHaveBeenCalledTimes(firstAttempts * 3);
  f.hidden(true);
  f.hidden(false);
  await f.flush();
  expect(vi.getTimerCount()).toBe(1);
  f.hidden(true);
  expect(vi.getTimerCount()).toBe(0);
  f.hidden(false);
  await f.flush();
  f.release();
  await f.flush();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['missing', 'invalid', 'capacity'])('确定失败 %s 不做网络重试', async (kind) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { DecorationFrameFetchError } = await import('../src/renderer/src/lib/frameImageSize');
  const { InvalidDecorationFrameError } = await import('../src/shared/decoration_image');
  const { DecodeCapacityError } = await import('../src/renderer/src/lib/decodedImageCache');
  const error =
    kind === 'missing'
      ? new DecorationFrameFetchError(404)
      : kind === 'invalid'
        ? new InvalidDecorationFrameError('损坏图片')
        : new DecodeCapacityError('预算已满');
  const f = await fixture(false, false, () => error);
  await f.flush();
  const attempts = f.decode.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  window.dispatchEvent(new Event('online'));
  await f.flush();
  expect(f.decode).toHaveBeenCalledTimes(attempts);
  expect(f.style()).not.toContain('animation: weq-widgetframe-95002');
  expect(vi.getTimerCount()).toBe(0);
});
