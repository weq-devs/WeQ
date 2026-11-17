import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureEmoji = await readFile(resolve(root, '../../resources/pokeemoji/0.png'));
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
          body: fixtureEmoji,
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
      assert.deepEqual((await menu.locator('code').allTextContents()).slice(0, 3), [
        '/qiang',
        '/xk',
        '/:)',
      ]);
      const box = await menu.boundingBox();
      assert.ok(box && box.width <= 224, '候选菜单过宽');
      const metrics = await menu
        .getByRole('option')
        .first()
        .evaluate((node) => ({
          height: node.getBoundingClientRect().height,
          font: getComputedStyle(node).fontSize,
          codeFont: getComputedStyle(node.querySelector('code')).fontSize,
          family: getComputedStyle(node).fontFamily,
          appFamily: getComputedStyle(document.body).fontFamily,
        }));
      assert.equal(metrics.height, 30);
      assert.equal(metrics.font, '13px');
      assert.equal(metrics.codeFont, metrics.font);
      assert.equal(metrics.family, metrics.appFamily);
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
      await editor.fill('/bx');
      await menu.getByRole('option', { name: '拜谢 /bx', exact: true }).waitFor();
      if (output)
        await page.screenshot({ path: resolve(output, `shortcode-${theme}-${width}.png`) });
      await editor.press('Enter');
      assert.equal(
        await editor.locator('img[data-chat-token]').getAttribute('data-chat-token'),
        '[[chat:face:297]]',
      );
      assert.deepEqual(await page.evaluate(() => window.slashQA.sent), []);
      await editor.press('Meta+z');
      assert.equal(await editor.textContent(), '/bx');
      await editor.fill('/XK');
      await menu.getByRole('option', { name: '笑哭 /xk', exact: true }).click();
      assert.equal(
        await editor.locator('img[data-chat-token]').getAttribute('data-chat-token'),
        '[[chat:face:182]]',
      );
      assert.deepEqual(await page.evaluate(() => window.slashQA.sent), []);
      await editor.fill('/w');
      assert.deepEqual(await menu.locator('code').allTextContents(), ['/weak', '/wx']);
      await editor.fill('/s');
      assert.deepEqual(await menu.locator('code').allTextContents(), ['/strong']);
      await editor.fill('/strong');
      await menu.getByRole('option', { name: '赞 /strong', exact: true }).waitFor();
      await editor.fill('/ron');
      assert.equal(await menu.count(), 0);
      await page.evaluate(() => window.slashQA.preferences(true, true));
      await editor.fill('/str');
      assert.equal(await editor.locator('img[data-chat-token]').count(), 0);
      await editor.pressSequentially('ong');
      assert.equal(await editor.locator('img').getAttribute('data-chat-token'), '[[chat:face:76]]');
      await editor.press('Meta+z');
      assert.equal(await editor.textContent(), '/strong');
      await editor.press('ArrowLeft');
      assert.equal(await editor.locator('img').count(), 0);
      await editor.fill('');
      await editor.pressSequentially('/qiang');
      assert.equal(await editor.locator('img').getAttribute('data-chat-token'), '[[chat:face:76]]');
      await page.evaluate(() => window.slashQA.preferences(false, true));
      await editor.fill('/bx');
      assert.equal(await editor.locator('img').count(), 0);
      assert.equal(await menu.count(), 0);
      await page.evaluate(() => window.slashQA.preferences(true, false));
      await editor.fill('https://example.com/xk');
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
        await expanded.fill('/xk');
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
          '[[chat:face:182]]',
        );
        await page.evaluate(() => window.slashQA.preferences(true, true));
        await expanded.fill('/strong');
        assert.equal(
          await expanded.locator('img').getAttribute('data-chat-token'),
          '[[chat:face:76]]',
        );
        await page.evaluate(() => window.slashQA.preferences(true, false));
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
      await page.evaluate(() => localStorage.clear());
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/slash-emoji.html?settings`,
      );
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      const enabled = page.getByRole('switch', { name: '斜杠表情快捷输入', exact: true });
      const automatic = page.getByRole('switch', { name: '无需回车即自动替换', exact: true });
      await automatic.waitFor();
      assert.equal(await automatic.getAttribute('aria-checked'), 'false');
      await automatic.click();
      assert.equal(await automatic.getAttribute('aria-checked'), 'true');
      await enabled.click();
      await automatic.waitFor({ state: 'hidden' });
      await enabled.click();
      await automatic.waitFor();
      assert.equal(await automatic.getAttribute('aria-checked'), 'true');
      if (output)
        await page.screenshot({ path: resolve(output, `settings-${theme}-${width}.png`) });
      await page.close();
    }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      scenes: 6,
      keyboard: true,
      ime: true,
      overlay3000: true,
      compactMenu: true,
      autoReplace: true,
      settings: true,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
