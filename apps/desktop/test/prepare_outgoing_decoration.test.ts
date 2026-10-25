import { afterEach, expect, it, vi } from 'vitest';
import { prepareOutgoingDecoration } from '../src/renderer/src/lib/prepareOutgoingDecoration';
import { fontFaces } from '../src/renderer/src/lib/fontFaces';

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
afterEach(() => {
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else Reflect.deleteProperty(document, 'fonts');
  vi.unstubAllGlobals();
});

it('字体文件加载并注册、样式已就绪后才允许首次显示发送消息，交接后完整释放', async () => {
  let finish: () => void = () => {};
  let requested = false;
  const add = vi.fn(),
    remove = vi.fn();
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add, delete: remove } });
  vi.stubGlobal(
    'FontFace',
    class {
      load() {
        requested = true;
        return new Promise<this>((resolve) => {
          finish = () => resolve(this);
        });
      }
    },
  );
  let ready = false;
  const resolve = vi.fn(async () => ({
    bubble: null,
    widget: null,
    font: { itemId: 31001, deriveVersion: 1, fx: null, localFile: 'synthetic.ttf' },
  }));
  const pending = prepareOutgoingDecoration(
    { bubbleId: 0, fontId: 31001, widgetId: 0 },
    resolve,
  ).then((release) => {
    ready = true;
    return release;
  });
  await vi.waitFor(() => expect(requested).toBe(true));
  expect(ready).toBe(false);
  expect(document.head.querySelector('[data-weq-msg-decoration^="font:"]')).toBeNull();
  finish();
  const release = await pending;
  expect(ready).toBe(true);
  expect(add).toHaveBeenCalledOnce();
  expect(fontFaces.count()).toBe(1);
  expect(document.head.querySelector('[data-weq-msg-decoration^="font:"]')?.textContent).toContain(
    'weq-message-dress-31001-1',
  );
  release();
  await vi.waitFor(() => expect(fontFaces.count()).toBe(0));
  expect(remove).toHaveBeenCalledOnce();
  expect(document.head.querySelector('[data-weq-msg-decoration]')).toBeNull();
});
