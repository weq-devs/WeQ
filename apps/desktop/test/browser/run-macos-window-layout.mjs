import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.cache/macos-window-layout-vite'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"electron"' },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
let temporary;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 600, height: 900 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.addInitScript(() => {
    let style = 'native';
    let fullscreen = false;
    const listeners = new Set();
    const ipcListeners = new Map();
    const snapshot = () => ({
      controls: style,
      inline: style === 'native',
      layout: {
        width: innerWidth,
        height: innerHeight,
        topLeft:
          style === 'native' && !fullscreen ? { width: 76, height: 40 } : { width: 0, height: 0 },
        topRight: { width: 0, height: 0 },
      },
    });
    window.weq = {
      windowChrome: {
        getSnapshot: snapshot,
        onChange: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    };
    window.electron = {
      process: { platform: 'darwin' },
      ipcRenderer: {
        on: (channel, handler) => {
          ipcListeners.set(channel, handler);
          return () => ipcListeners.delete(channel);
        },
        invoke: async () => style,
        send() {},
      },
    };
    window.setWindowChrome = (next, full) => {
      style = next;
      fullscreen = full;
      ipcListeners.get('window:controls-changed')?.(null, style);
      for (const listener of listeners) listener(snapshot());
    };
    const first = new MutationObserver(() => {
      const header = document.querySelector('.chat-header');
      if (!header?.getBoundingClientRect().width) return;
      window.firstMacHeader = {
        top: header.getBoundingClientRect().top,
        left: getComputedStyle(header).paddingLeft,
      };
      first.disconnect();
    });
    first.observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${origin}/test/browser/desktop-portrait.html`);
  const editor = page.locator('.composer > .composer-editor');
  await editor.fill('macOS 窄窗保留草稿和输入焦点');
  await editor.focus();
  assert.deepEqual(await page.evaluate(() => window.firstMacHeader), { top: 0, left: '84px' });
  const output = process.env.WEQ_RESPONSIVE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [600, 430, 320, 800, 1180, 600]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [style, fullscreen] of [
      ['native', false],
      ['native', true],
      ['windows', false],
      ['native', false],
    ]) {
      await page.evaluate(
        ([style, fullscreen]) => window.setWindowChrome(style, fullscreen),
        [style, fullscreen],
      );
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          window.desktopPortraitQa.store.getState().setPreference(theme);
          window.desktopPortraitQa.store
            .getState()
            .setAccent(theme === 'light' ? '#15764a' : '#ebbd51');
        }, theme);
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const geometry = await page.evaluate(
          ({ style, fullscreen }) => {
            const visible = (node) => {
              const rect = node.getBoundingClientRect();
              return rect.width && rect.height && getComputedStyle(node).visibility !== 'hidden';
            };
            const headers = [
              ...document.querySelectorAll('.app-title-bar, .weq-mobile-header, .chat-header'),
            ].filter(visible);
            return {
              overlap:
                style === 'native' &&
                !fullscreen &&
                document.documentElement.dataset.weqLayout === 'single'
                  ? headers.flatMap((header) =>
                      [...header.querySelectorAll('button')]
                        .filter(visible)
                        .filter((button) => {
                          const rect = button.getBoundingClientRect();
                          return (
                            rect.left < 76 && rect.right > 0 && rect.top < 40 && rect.bottom > 0
                          );
                        })
                        .map((node) => node.outerHTML),
                    )
                  : [],
              titlebar: getComputedStyle(document.querySelector('.app-title-bar')).display,
              chatTop: document.querySelector('.chat-header').getBoundingClientRect().top,
              headerHeight: document.querySelector('.chat-header').getBoundingClientRect().height,
              overflow: document.documentElement.scrollWidth > innerWidth,
              focused: document.activeElement === document.querySelector('.composer-editor'),
              draft: document.querySelector('.composer-editor').textContent,
            };
          },
          { style, fullscreen },
        );
        assert.deepEqual(
          geometry.overlap,
          [],
          JSON.stringify({ width, style, fullscreen, geometry }),
        );
        assert.equal(geometry.overflow, false);
        assert.equal(geometry.focused, true);
        assert.equal(geometry.draft, 'macOS 窄窗保留草稿和输入焦点');
        if (width <= 760) {
          assert.equal(geometry.titlebar === 'none', style === 'native');
          assert.equal(geometry.chatTop, style === 'native' ? 0 : 40);
          if (style === 'native' && fullscreen) assert.equal(geometry.headerHeight, 56);
        }
        if (output && theme === 'light')
          await page.screenshot({
            path: resolve(output, `macos-${width}-${style}-${fullscreen}.png`),
          });
        cases++;
      }
    }
  }
  await page.evaluate(() => {
    window.setWindowChrome('native', false);
    window.openWindowLayoutPreview();
  });
  await page.locator('.weq-preview-header[data-weq-window-chrome]').waitFor();
  assert.equal(
    await page
      .locator('.weq-preview-header')
      .evaluate((node) => getComputedStyle(node).paddingLeft),
    '84px',
  );
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  assert.deepEqual(errors, []);
  await mkdir(resolve(root, '.artifacts'), { recursive: true });
  temporary = await mkdtemp(resolve(root, '.artifacts/macos-window-chrome-'));
  await build({
    entryPoints: [resolve(root, 'src/main/window_chrome.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: resolve(temporary, 'main.mjs'),
  });
  await build({
    stdin: {
      contents:
        "import {contextBridge} from 'electron'; import {electronAPI} from '@electron-toolkit/preload'; import {windowChromeBridge} from './src/preload/window_chrome'; contextBridge.exposeInMainWorld('weq',{windowChrome:windowChromeBridge}); contextBridge.exposeInMainWorld('electron',electronAPI);",
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile: resolve(temporary, 'preload.cjs'),
  });
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      createRequire(import.meta.url)('electron'),
      [resolve(root, 'test/electron/macos_window_chrome.cjs')],
      {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, WEQ_CHROME_TEMP: temporary, WEQ_CHROME_ORIGIN: origin },
      },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`Electron: ${code}`)),
    );
  });
  console.log(
    `PASS: ${cases} 个 macOS 单栏/多栏、原生/自绘按钮与全屏合成场景，原生 Electron 桥接通过`,
  );
} finally {
  await browser?.close();
  await server.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
