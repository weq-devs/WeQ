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
  cacheDir: resolve(root, 'node_modules/.vite-settings-tool-entries'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/mobile-surfaces.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
  const output = process.env.WEQ_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const errors = [];
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
      );
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-navigation.html`,
      );
      await page.evaluate((theme) => {
        const store = window.settingsNavigationQa.theme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#b5243e' : '#81c995');
        store.setBackground(theme === 'light' ? 'paper' : 'grid');
      }, theme);
      const openCategory = async (label) => {
        if (width <= 760)
          await page.getByRole('button', { name: '返回设置分类', exact: true }).click();
        await page
          .locator('.weq-settings-nav')
          .getByRole('button', { name: label, exact: true })
          .click();
      };
      const checkButton = async (id, name, cardTitle, tool) => {
        const button = page.locator(`button[data-setting-id="${id}"]`);
        await button.scrollIntoViewIfNeeded();
        assert.equal(await button.innerText(), name);
        const card = button.locator('xpath=ancestor::section[contains(@class,"weq-set-card")][1]');
        assert.equal(await card.count(), 1);
        assert.equal(await card.locator('.weq-set-card-title').first().innerText(), cardTitle);
        assert.equal(await card.locator('.weq-set-card').count(), 0);
        const geometry = await button.evaluate((node) => {
          const button = node.getBoundingClientRect();
          const card = node.closest('.weq-set-card').getBoundingClientRect();
          const label = node.closest('.weq-set-row')?.querySelector('.weq-set-row-label');
          const text = label?.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            contained: button.left >= card.left && button.right <= card.right,
            separated: !text || text.right <= button.left || text.bottom <= button.top,
            fits: node.scrollWidth <= node.clientWidth + 1,
            border: style.borderRadius,
          };
        });
        assert(geometry.contained && geometry.separated && geometry.fits, JSON.stringify(geometry));
        await button.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        assert(await button.evaluate((node) => node.matches(':focus-visible')));
        await page.keyboard.press('Enter');
        assert.equal(
          await page.evaluate(() => window.settingsNavigationQa.launchedTools.at(-1)),
          tool,
        );
        assert.equal(await page.locator('.weq-maintenance-entry').count(), 0);
      };
      await openCategory('凭据与数据');
      await page.getByRole('button', { name: 'QQ 高级工具', exact: true }).click();
      await checkButton('qqnt-capture', '打开抓包', 'QQNT 抓包', 'capture');
      if (output) await page.screenshot({ path: resolve(output, `capture-${width}-${theme}.png`) });
      await page.getByRole('button', { name: '凭据管理', exact: true }).click();
      await checkButton('key-scan', '打开密钥扫描', '密钥工具', 'key-scan');
      await checkButton('other-device-key', '查看设备密钥', '密钥工具', 'other-device-key');
      if (output) await page.screenshot({ path: resolve(output, `keys-${width}-${theme}.png`) });
      await page.getByRole('button', { name: 'QQ 数据库管理', exact: true }).click();
      await checkButton('database-repair', '打开修复工具', '容错与修复', 'db-repair');
      if (output) await page.screenshot({ path: resolve(output, `repair-${width}-${theme}.png`) });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      cases++;
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, toolActivations: cases * 4, errors }));
} finally {
  await browser?.close();
  await server.close();
}
