import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-marker-settings'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('electron') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/marker-settings.stub.ts'),
      },
      {
        find: /^.*\/hooks\/useAppUpdate$/,
        replacement: resolve(root, 'test/browser/app-update.stub.ts'),
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const output = process.env.WEQ_MARKER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1180])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/marker-settings.html`,
      );
      await page.getByRole('button', { name: '更新标记设置', exact: true }).first().waitFor();
      await page.evaluate((theme) => {
        const store = window.markerQa.theme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#b5243e' : '#81c995');
        store.setBackground(theme === 'light' ? 'grid' : 'telegram');
      }, theme);
      const placements = [
        [
          '[data-testid="version"] .weq-set-card:has(.weq-update-interval-control)',
          '更新标记设置',
          'update-badge',
        ],
        ['[data-setting-id="enhancement-updates"]', '更新标记设置', 'update-badge'],
        ['.contact-notice-row', '申请未读标记设置', 'contact-request-badge'],
        ['.weq-current-tasks-results', '任务结果标记设置', 'task-result-badge'],
      ];
      assert.equal(await page.locator('.weq-set-head .weq-set-iconbtn').count(), 0);
      assert.equal(await page.locator('.weq-current-tasks-head .weq-set-iconbtn').count(), 0);
      assert.equal(await page.locator('.weq-current-tasks-results').innerText(), '1 项已结束');
      for (const [selector, label, settingId] of placements) {
        const button = page.locator(selector).getByRole('button', { name: label, exact: true });
        assert.equal(await button.count(), 1, selector);
        assert.equal(await button.getAttribute('title'), label);
        await button.click();
        assert.deepEqual(await page.evaluate(() => window.markerQa.navigations.at(-1)), {
          section: 'global',
          settingId,
        });
        const fits = await button.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const area = node.parentElement.getBoundingClientRect();
          return box.width > 0 && box.left >= area.left && box.right <= area.right + 1;
        });
        assert(fits, `${width}/${theme}: ${label} fits beside its feature`);
        await button.focus();
        assert(await button.evaluate((node) => node === document.activeElement));
      }
      const directory = page.getByTestId('contacts');
      for (const size of [160, 320]) {
        await directory.evaluate((node, size) => {
          node.style.width = `min(100%, ${size}px)`;
        }, size);
        const row = page.locator('.contact-notice-row');
        assert.equal(await row.locator('.notice-entry-text:visible').count(), size === 160 ? 0 : 2);
        const overlap = await row.locator(':scope > button').evaluateAll((buttons) =>
          buttons.some((button, index) => {
            const box = button.getBoundingClientRect();
            const next = buttons[index + 1]?.getBoundingClientRect();
            return next && box.right > next.left;
          }),
        );
        assert.equal(overlap, false, `contact entries: ${size}`);
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/marker-settings.html?empty`,
      );
      await page.locator('.weq-current-tasks-results').waitFor();
      assert.equal(await page.locator('.weq-current-tasks-results').innerText(), '0 项已结束');
      assert.equal(
        await page.getByRole('button', { name: '任务结果标记设置', exact: true }).count(),
        1,
      );
      cases++;
    }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, placements: 4, navigations: 'passed', errors }));
} finally {
  await browser?.close();
  await server.close();
}
