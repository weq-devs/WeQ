// @vitest-environment node
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { loadIsolatedHtml } from '../src/main/html_load';

it('离线捕获只放行当前 HTML 与内联资源，拒绝其他文件、网络、导航和设备权限', async () => {
  const onBeforeRequest = vi.fn(),
    on = vi.fn(),
    once = vi.fn();
  const setPermissionRequestHandler = vi.fn(),
    setPermissionCheckHandler = vi.fn();
  const loadURL = vi.fn(async (url: string) => {
    expect(await readFile(fileURLToPath(url), 'utf8')).toBe('<html>fixture</html>');
  });
  const win = {
    webContents: {
      session: {
        webRequest: { onBeforeRequest },
        setPermissionRequestHandler,
        setPermissionCheckHandler,
      },
      on,
    },
    once,
    loadURL,
  } as unknown as BrowserWindow;
  await loadIsolatedHtml(win, '<html>fixture</html>', { offline: true });
  const url = loadURL.mock.calls[0]![0];
  const filter = onBeforeRequest.mock.calls[0]![0];
  for (const [candidate, cancel] of [
    [url, false],
    ['data:image/png;base64,abc', false],
    ['file:///private/fixture', true],
    ['https://example.invalid', true],
    ['http://127.0.0.1:7690/', true],
  ] as const) {
    const callback = vi.fn();
    filter({ url: candidate }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel });
  }
  for (const [event, callback] of on.mock.calls) {
    expect(['will-navigate', 'will-redirect']).toContain(event);
    const preventDefault = vi.fn();
    callback({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  }
  expect(setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false);
  const permission = vi.fn();
  setPermissionRequestHandler.mock.calls[0]![0](null, 'media', permission);
  expect(permission).toHaveBeenCalledWith(false);
  once.mock.calls[0]![1]();
  await vi.waitFor(async () =>
    expect(
      await access(fileURLToPath(url)).then(
        () => true,
        () => false,
      ),
    ).toBe(false),
  );
});
