import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.cache/slash-emoji'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/slash-emoji.stub.ts'),
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
  const output = process.env.WEQ_SLASH_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const errors = [];
  for (const width of [320, 390, 1280])
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/_asset/emoji/**', (route) =>
        route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VxQAAAAASUVORK5CYII=',
            'base64',
          ),
        }),
      );
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/slash-emoji.html`,
      );
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#15764a' : '#ebbd51',
        );
      }, theme);
      const editor = page.getByRole('textbox', { name: '消息', exact: true });
      await editor.fill('/');
      const menu = page.getByRole('listbox', { name: '表情候选' });
      await menu.waitFor();
      assert.ok((await menu.getByRole('option').count()) > 8);
      const box = await menu.boundingBox();
      assert.ok(
        box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= width + 1 &&
          box.y + box.height <= 900,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      await editor.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await editor.textContent(), '/');
      await editor.fill('/微笑');
      await menu.getByRole('option', { name: '微笑', exact: true }).waitFor();
      await editor.press('Enter');
      assert.equal(
        await editor.locator('img[data-chat-token]').getAttribute('data-chat-token'),
        '[[chat:face:14]]',
      );
      assert.deepEqual(await page.evaluate(() => window.slashQA.sent), []);
      await editor.press('Meta+z');
      assert.equal(await editor.textContent(), '/微笑');
      await editor.fill('https://example.com/笑');
      assert.equal(await menu.count(), 0);
      await editor.fill('/');
      await editor.evaluate((node) =>
        node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })),
      );
      assert.equal(await menu.count(), 0);
      await editor.evaluate((node) =>
        node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })),
      );
      await menu.waitFor();
      await page.evaluate(() => window.slashQA.switchConversation());
      await menu.waitFor({ state: 'hidden' });
      if (width < 760) {
        await editor.fill(`${'多行正文\n'.repeat(8)}/`);
        await page.getByRole('button', { name: '展开输入', exact: true }).click();
        const expanded = page.locator('.mobile-composer-expanded-editor');
        await expanded.fill('/微笑');
        await menu.waitFor();
        const expandedBox = await menu.boundingBox();
        assert.ok(expandedBox && expandedBox.y >= 0 && expandedBox.y + expandedBox.height <= 900);
        assert.equal(
          await page.getByRole('button', { name: '收起输入', exact: true }).evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            );
            return hit === node || node.contains(hit);
          }),
          true,
          '表情候选遮挡收起输入按钮',
        );
        if (output)
          await page.screenshot({ path: resolve(output, `expanded-${theme}-${width}.png`) });
        await expanded.press('Tab');
        assert.equal(
          await expanded.locator('img[data-chat-token]').getAttribute('data-chat-token'),
          '[[chat:face:14]]',
        );
        await page.getByRole('button', { name: '收起输入', exact: true }).click();
      }
      if (width === 1280 && theme === 'dark') {
        await page.evaluate(() => window.slashQA.stress());
        const toast = page.locator('[data-qa-toast]');
        assert.equal(
          await toast.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node;
          }),
          true,
        );
        await toast.click();
      }
      await page.close();
    }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, scenes: 6, keyboard: true, ime: true, overlay3000: true }),
  );
} finally {
  await browser?.close();
  await server.close();
}
