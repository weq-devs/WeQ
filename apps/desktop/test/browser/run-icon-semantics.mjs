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
  cacheDir: resolve(root, 'node_modules/.cache/icon-semantics-vite'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
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
let page;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultNavigationTimeout(90_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_ICON_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark', 'system']) {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/icon-semantics.html`,
      );
      await page.waitForFunction(() => window.iconQa);
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.evaluate((theme) => {
        const store = window.iconQa.theme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#15764a' : '#ebbd51');
        store.setBackground(theme === 'light' ? 'plain' : 'grid');
      }, theme);
      await page.locator('.weq-app-search .weq-search-row').last().waitFor();
      const shapes = await page
        .locator('.weq-app-search .weq-search-source-icon svg')
        .evaluateAll((icons) => icons.map((icon) => icon.innerHTML));
      assert.equal(new Set(shapes).size, shapes.length);
      assert.equal(shapes.length, 8);
      for (const icon of await page.locator('.weq-app-search .weq-search-source-icon svg').all()) {
        const rect = await icon.boundingBox();
        assert(rect && rect.width === 20 && rect.height === 20);
        assert.equal(
          await icon.evaluate((node) => Boolean(node.closest('[aria-hidden="true"]'))),
          true,
        );
      }
      await page.getByRole('option').filter({ hasText: 'QQ 空间' }).click();
      assert.deepEqual(await page.evaluate(() => window.iconQa.selected), ['qzone.timeline']);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (output && theme !== 'system')
        await page.screenshot({ path: resolve(output, `search-${width}-${theme}.png`) });

      await page.evaluate(() => window.iconQa.show('brand'));
      for (const size of [16, 22, 44]) {
        const actual = page.locator(`[data-brand-actual="${size}"]`);
        const reference = page.locator(`[data-brand-reference="${size}"]`);
        assert.equal(
          (await actual.screenshot()).equals(await reference.screenshot()),
          true,
          `${size}px QQ 空间应与原始实心标识像素一致`,
        );
        assert.equal(
          await actual.locator('svg').evaluate((node) => getComputedStyle(node).stroke),
          'none',
        );
      }
      for (const [section, title, iconClass] of [
        ['qzone', 'QQ 空间', null],
        ['privacy', '隐私', 'lucide-eye-off'],
        ['agentlab', 'API 配置', 'lucide-boxes'],
        ['reply-suggestions', '推荐回复', 'lucide-message-square-reply'],
      ]) {
        await page.evaluate((section) => window.iconQa.show('settings', section), section);
        const header = page
          .locator('.weq-set-head:visible')
          .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
          .first();
        await header.waitFor();
        const icon = header.locator('.weq-set-head-icon svg');
        assert.equal(await icon.count(), 1);
        const rect = await icon.boundingBox();
        assert(rect && rect.width === 16 && rect.height === 16);
        if (iconClass)
          assert.equal(
            await icon.evaluate((node, name) => node.classList.contains(name), iconClass),
            true,
          );
        else assert.equal(await icon.getAttribute('stroke'), 'none');
        if (section === 'qzone') {
          for (const title of await page.locator('.weq-qzone-permissions h4').all())
            assert.equal(await title.locator('.weq-set-card-icon[aria-hidden] svg').count(), 1);
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        if (width > 760) {
          const navIcon = page
            .locator('.weq-settings-subnav-item')
            .filter({ hasText: title })
            .locator('svg');
          assert.equal(await navIcon.innerHTML(), await icon.innerHTML());
        }
        if (output && theme !== 'system' && section === 'qzone')
          await page.screenshot({ path: resolve(output, `settings-${width}-${theme}.png`) });
        cases++;
      }

      await page.evaluate(() => window.iconQa.show('audit'));
      const contentRows = page.locator('.weq-export-content-row:not(.is-detail)');
      await contentRows.last().waitFor();
      const contentIcons = await contentRows
        .locator('.weq-export-content-label > svg')
        .evaluateAll((icons) => icons.map((icon) => icon.innerHTML));
      assert.equal(new Set(contentIcons).size, contentIcons.length, '导出内容子项不撞图标');
      assert.equal(contentIcons.length, 12);
      const cloneIcons = await page
        .locator('.weq-virtual-avatar-badge svg')
        .evaluateAll((icons) => icons.map((icon) => icon.innerHTML));
      assert.equal(new Set(cloneIcons).size, 2);
      await page.getByRole('button', { name: '重试分析', exact: true }).click();
      await page.getByText('读取失败 1', { exact: true }).waitFor();
      if (output && theme !== 'system')
        await page.screenshot({ path: resolve(output, `audit-${width}-${theme}.png`) });
      await page.getByRole('button', { name: '消息装扮', exact: true }).click();
      const decoration = page.getByRole('dialog', { name: '消息装扮', exact: true });
      await decoration.waitFor();
      const labels = await decoration
        .locator('.weq-decoration-card-header svg')
        .evaluateAll((icons) =>
          icons.map((icon) => ({
            shape: icon.innerHTML,
            rect: icon.getBoundingClientRect().toJSON(),
          })),
        );
      assert.equal(new Set(labels.map(({ shape }) => shape)).size, 3);
      assert(labels.every(({ rect }) => rect.width === 18 && rect.height === 18));
      const bounds = await decoration.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      if (output && theme !== 'system')
        await page.screenshot({ path: resolve(output, `decoration-${width}-${theme}.png`) });
      await decoration.getByRole('button', { name: '关闭', exact: true }).click();
      await decoration.waitFor({ state: 'detached' });
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, brandPixelComparisons: 27, errors }));
} catch (error) {
  if (page) {
    console.error((await page.locator('body').innerText()).slice(0, 3000));
    if (process.env.WEQ_ICON_ARTIFACTS)
      await page.screenshot({ path: resolve(process.env.WEQ_ICON_ARTIFACTS, 'failure.png') });
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
