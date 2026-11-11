import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/composer-attachments-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  optimizeDeps: { entries: ['test/browser/timeline.html'] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'trpc.stub.ts') },
      {
        find: /^@weq\/agentlab$/,
        replacement: resolve(root, '../../packages/agentlab/src/model_selection.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: [resolve(root, '../..')] },
  },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_COMPOSER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const [width, theme, accent] of [
    [1280, 'light', '#15764a'],
    [1280, 'dark', '#ebbd51'],
    [390, 'light', '#b53358'],
    [390, 'dark', '#73cab8'],
    [320, 'dark', '#73cab8'],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    try {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?composer-actions&count=30`,
      );
      const editor = page.locator('.composer > .composer-editor');
      await editor.waitFor();
      await page.evaluate(
        ({ theme, accent }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.background = theme === 'light' ? 'paper' : 'dots';
          document.documentElement.style.setProperty('--weq-accent-effective', accent);
        },
        { theme, accent },
      );
      await editor.fill('批量发送正文');
      const files = page.locator('.composer input[type="file"]:not([accept])');
      assert.equal(await files.getAttribute('multiple'), '');
      await files.setInputFiles([
        {
          name: '项目资料与很长的文件名称用于检验省略显示.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('one'),
        },
        { name: 'second.pdf', mimeType: 'application/pdf', buffer: Buffer.from('two') },
      ]);
      await page.locator('.composer-media-tray .composer-single-card').nth(1).waitFor();
      await files.setInputFiles([
        { name: 'remove.txt', mimeType: 'text/plain', buffer: Buffer.from('remove') },
      ]);
      await page.getByRole('button', { name: '移除 remove.txt', exact: true }).click();
      await page.locator('.composer-tools button[title="发送图片或文件"]').click();
      assert(await page.getByRole('menuitem', { name: '发送图片', exact: true }).isEnabled());
      await page.keyboard.press('Escape');
      // 真实解码并持久化 20 项上限内的图片；与文件混合拖入不能丢失。
      await page.evaluate(() => {
        const bytes = Uint8Array.from(
          atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
          ),
          (char) => char.charCodeAt(0),
        );
        const data = new DataTransfer();
        data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
        data.items.add(new File(['three'], 'third.txt', { type: 'text/plain' }));
        document
          .querySelector('.composer')
          .dispatchEvent(
            new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }),
          );
      });
      await page.locator('.composer-media-tray .composer-single-card').nth(2).waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector('.composer-editor img');
        return image?.complete && image.naturalWidth > 0;
      });
      assert(await editor.isVisible());
      const geometry = await page.evaluate(() => {
        const rect = (selector) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, height: box.height };
        };
        return {
          tray: rect('.composer-media-tray'),
          editor: rect('.composer > .composer-editor'),
          send: rect('.composer > .composer-send'),
          toolbar: rect('.composer-tools'),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert(!geometry.overflow, JSON.stringify(geometry));
      assert(geometry.tray.bottom <= geometry.editor.y + 1, JSON.stringify(geometry));
      assert(geometry.editor.height >= 40, JSON.stringify(geometry));
      const send = page.locator('.composer > .composer-send');
      assert.equal(await send.isVisible(), width > 760);
      if (width <= 760) {
        assert(geometry.editor.bottom <= geometry.toolbar.y + 1, JSON.stringify(geometry));
      } else {
        assert(
          geometry.send.bottom <= 900 && geometry.send.right <= width,
          JSON.stringify(geometry),
        );
      }
      if (output)
        await page.screenshot({ path: resolve(output, `${theme}-${width}-attachments.png`) });
      if (width <= 760) await editor.press('Enter');
      else await send.click();
      await page.waitForFunction(() => window.timelineTest.sentBodies().length === 4);
      const sent = await page.evaluate(() => window.timelineTest.sentBodies());
      assert(sent[0].startsWith('批量发送正文') && sent[0].includes('[[chat:elem:'));
      assert.equal(await page.locator('.composer-media-tray').count(), 0);
      assert.equal(await editor.textContent(), '');
      if (width <= 760) {
        await files.setInputFiles([
          { name: 'only-file.txt', mimeType: 'text/plain', buffer: Buffer.from('no text') },
        ]);
        await page.locator('.composer-media-tray .composer-single-card').waitFor();
        await editor.press('Enter');
        await page.waitForFunction(() => window.timelineTest.sentBodies().length === 5);
        assert.equal(await page.locator('.composer-media-tray').count(), 0);
        assert.equal(await editor.textContent(), '');
      }
      if (width === 1280 && theme === 'light') {
        const image = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
          'base64',
        );
        await page.locator('.composer input[accept="image/*"][multiple]').setInputFiles(
          Array.from({ length: 20 }, (_, i) => ({
            name: `batch-${i}.png`,
            mimeType: 'image/png',
            buffer: image,
          })),
        );
        await page.waitForFunction(
          () => document.querySelectorAll('.composer-editor img').length === 20,
        );
        await page.locator('.composer > .composer-send').click();
        await page.waitForFunction(() => window.timelineTest.sentBodies().length === 5);
        const body = await page.evaluate(() => window.timelineTest.sentBodies()[4]);
        assert(body.length > 4000);
        assert.equal(body.match(/\[\[chat:elem:/g)?.length, 20);
      }
      assert.deepEqual(errors, []);
      results.push({ width, theme, messages: sent.length, geometry });
    } finally {
      await page.close();
    }
  }
  console.log(JSON.stringify({ results }));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
