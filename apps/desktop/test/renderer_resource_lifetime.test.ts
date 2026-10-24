import { afterEach, expect, it, vi } from 'vitest';

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
afterEach(() => {
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else Reflect.deleteProperty(document, 'fonts');
  for (const node of document.head.querySelectorAll('[data-weq-msg-decoration]')) node.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('清空生效字体后，迟到的加载不能重新注册', async () => {
  const add = vi.fn();
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add, delete: vi.fn() } });
  let finish = () => {};
  vi.stubGlobal(
    'FontFace',
    class {
      load() {
        return new Promise((resolve) => {
          finish = () => resolve(this);
        });
      }
    },
  );
  const { applyDressSkin } = await import('../src/renderer/src/lib/dressSkin');
  applyDressSkin(
    null,
    { itemId: 90001, deriveVersion: 1, fontUrl: 'fixture:font', fx: null },
    null,
  );
  applyDressSkin(null, null, null);
  finish();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(add).not.toHaveBeenCalled();
});

it('同款字体在途去重，最后一个持有者释放时撤销注册', async () => {
  const add = vi.fn(),
    remove = vi.fn();
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add, delete: remove } });
  const load = vi.fn(async function (this: object) {
    return this;
  });
  vi.stubGlobal(
    'FontFace',
    class {
      load = load;
    },
  );
  const { fontFaces } = await import('../src/renderer/src/lib/fontFaces');
  const a = fontFaces.acquire('fixture', 'fixture:font');
  const b = fontFaces.acquire('fixture', 'fixture:font');
  expect(await a.ready).toBe(true);
  expect(await b.ready).toBe(true);
  expect(load).toHaveBeenCalledTimes(1);
  a.release();
  expect(remove).not.toHaveBeenCalled();
  b.release();
  expect(remove).toHaveBeenCalledTimes(1);
});

it('快速取得后释放未加载字体，也不能绕过原生加载总量上限', async () => {
  const add = vi.fn();
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add, delete: vi.fn() } });
  const finish: (() => void)[] = [];
  vi.stubGlobal(
    'FontFace',
    class {
      load() {
        return new Promise((resolve) => finish.push(() => resolve(this)));
      }
    },
  );
  const { fontFaces, FONT_FACE_LIMIT } = await import('../src/renderer/src/lib/fontFaces');
  const pending: Promise<boolean>[] = [];
  for (let i = 0; i < FONT_FACE_LIMIT * 2; i++) {
    const font = fontFaces.acquire(`fixture-${i}`, `fixture:${i}`);
    pending.push(font.ready);
    font.release();
  }
  expect(finish).toHaveLength(FONT_FACE_LIMIT);
  expect(fontFaces.loading()).toBe(FONT_FACE_LIMIT);
  for (const complete of finish) complete();
  expect((await Promise.all(pending)).some(Boolean)).toBe(false);
  expect(add).not.toHaveBeenCalled();
  expect(fontFaces.count()).toBe(0);
  expect(fontFaces.loading()).toBe(0);
});

it('不同消息装扮卸载后释放 pin 和规则，预热完成前卸载不回填', async () => {
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      naturalWidth = 256;
      naturalHeight = 256;
      async decode() {}
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
  for (let id = 90001; id < 90021; id++) {
    const release = injectWidgetCss({
      animated: true,
      itemId: id,
      frameCount: 20,
      frameTimeMs: 100,
      repeat: 0,
    });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(decorationImageCache.stats().pinnedImages).toBe(20);
    release();
    expect(decorationImageCache.stats().pinnedImages).toBe(0);
    expect(document.querySelectorAll('[data-weq-msg-decoration]')).toHaveLength(0);
  }
  const release = injectWidgetCss({
    animated: true,
    itemId: 90100,
    frameCount: 20,
    frameTimeMs: 100,
    repeat: 0,
  });
  release();
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(decorationImageCache.stats().pinnedImages).toBe(0);
  expect(document.querySelectorAll('[data-weq-msg-decoration]')).toHaveLength(0);
  decorationImageCache.dispose();
});

it('同款样式共享，最后一个使用者离开才移除；失败的预热不开播', async () => {
  let broken = false;
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      naturalWidth = 256;
      naturalHeight = 256;
      async decode() {
        if (broken) throw new Error('合成解码失败');
      }
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
  const widget = {
    animated: true as const,
    itemId: 90200,
    frameCount: 20,
    frameTimeMs: 100,
    repeat: 0,
  };
  const first = injectWidgetCss(widget),
    second = injectWidgetCss(widget);
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(document.querySelectorAll('[data-weq-msg-decoration]')).toHaveLength(1);
  first();
  expect(decorationImageCache.stats().pinnedImages).toBe(20);
  expect(document.querySelectorAll('[data-weq-msg-decoration]')).toHaveLength(1);
  second();
  expect(decorationImageCache.stats().retainedBytes).toBe(0);
  broken = true;
  const stop = injectWidgetCss({ ...widget, itemId: 90201 });
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(document.querySelector('[data-weq-msg-decoration]')?.textContent).not.toContain(
    'animation: weq-widgetframe-90201',
  );
  expect(decorationImageCache.stats().pinnedImages).toBe(0);
  stop();
  decorationImageCache.dispose();
});

it('预算恢复后重新选择同款生效装扮可以重试，不永久停在失败状态', async () => {
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      naturalWidth = 512;
      naturalHeight = 512;
      async decode() {}
      removeAttribute() {
        this.src = '';
      }
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 0;
  });
  const { decorationImageCache, DECORATION_DECODE_LIMITS } = await import(
    '../src/renderer/src/lib/decodedImageCache'
  );
  const { applyDressSkin } = await import('../src/renderer/src/lib/dressSkin');
  const urls = Array.from(
    { length: DECORATION_DECODE_LIMITS.maxBytes / (512 * 512 * 4) },
    (_, i) => `fixture:block-${i}`,
  );
  const block = decorationImageCache.pin(urls);
  const widget = {
    animated: true as const,
    itemId: 90300,
    frameCount: 20,
    frameTimeMs: 100,
    repeat: 0,
  };
  try {
    await Promise.all(urls.map((url) => decorationImageCache.require(url)));
    applyDressSkin(null, null, widget);
    for (let i = 0; i < 150; i++) await Promise.resolve();
    expect(document.getElementById('weq-dress-skin')?.textContent).not.toContain(
      'animation: weq-widgetframe-90300',
    );
    block.release();
    applyDressSkin(null, null, widget);
    for (let i = 0; i < 150; i++) await Promise.resolve();
    expect(document.getElementById('weq-dress-skin')?.textContent).toContain(
      'animation: weq-widgetframe-90300',
    );
    expect(decorationImageCache.stats().pinnedImages).toBe(20);
  } finally {
    block.release();
    applyDressSkin(null, null, null);
    decorationImageCache.dispose();
  }
});
