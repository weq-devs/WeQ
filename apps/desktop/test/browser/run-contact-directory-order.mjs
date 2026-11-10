import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-contact-order'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/contact-directory-order.stub.ts'),
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-directory-order.html`,
  );
  const friends = page.locator('[data-kind="friends"]'),
    groups = page.locator('[data-kind="groups"]');
  await friends.locator('.weq-directory-order').waitFor();
  const headers = () =>
    friends.locator('.contact-cat-header:not([hidden]) .contact-cat-name').allTextContents();
  assert.deepEqual(await headers(), ['特别关心', '我的好友']);
  await friends.getByLabel('分组依据').selectOption('birthYear');
  assert.deepEqual(await headers(), ['2007 年', '2006 年', '2005 年']);
  await friends.getByLabel('分组依据').selectOption('relation');
  assert.deepEqual(await headers(), ['特别关心', '死党', '无亲密关系']);
  await friends.getByLabel('分组依据').selectOption('location');
  assert.deepEqual(new Set(await headers()), new Set(['福建', '美国']));
  for (const basis of [
    'qq',
    'birthYear',
    'constellation',
    'gender',
    'location',
    'relation',
    'direction',
    'none',
  ]) {
    await friends.getByLabel('分组依据').selectOption(basis);
    const stale = page.getByRole('dialog', { name: '更新好友/群信息缓存', exact: true });
    if (await stale.count()) {
      await stale.getByRole('radio', { name: '不更新', exact: true }).click();
      await stale.getByRole('button', { name: '仅刷新列表', exact: true }).click();
    }
    const names = await headers();
    assert.equal(names.includes('亲密关系'), false);
    assert.equal(names.includes('特别关心'), basis === 'qq' || basis === 'relation');
  }
  await friends.getByLabel('分组依据').selectOption('none');
  assert.equal(await friends.locator('.contact-cat-header:not([hidden])').count(), 0);
  assert.equal(await friends.locator('.contact-row').count(), 3);
  await friends.getByLabel('排序依据').selectOption('age');
  assert.deepEqual(await friends.locator('.contact-row .row-title-text').allTextContents(), [
    '张同学',
    '白雪',
    '阿明',
  ]);
  await friends.getByRole('button', { name: '改为升序', exact: true }).click();
  assert.deepEqual(await friends.locator('.contact-row .row-title-text').allTextContents(), [
    '阿明',
    '白雪',
    '张同学',
  ]);
  await groups.getByLabel('分组依据').selectOption('capacity');
  assert.deepEqual(await groups.locator('.contact-cat-name').allTextContents(), [
    '200 人群',
    '500 人群',
  ]);
  await groups.getByLabel('分组依据').selectOption('none');
  assert.equal(await groups.locator('.contact-cat-header:not([hidden])').count(), 0);
  assert.equal(await groups.locator('.contact-row').count(), 3);
  assert.equal(await page.locator('[data-kind="tasks"] .weq-exp-log').count(), 1);
  assert.equal(await page.locator('[data-kind="tasks"] .weq-exp-detail-stage').count(), 0);
  assert.equal(await page.locator('[data-kind="tasks"] details').count(), 0);
  assert.ok(
    (await page.locator('[data-kind="tasks"] .weq-exp-log-text').first().textContent()).includes(
      '阿明',
    ),
  );
  const output = process.env.WEQ_CONTACT_ORDER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((width) => {
        for (const section of document.querySelectorAll(
          '[data-kind="friends"], [data-kind="groups"]',
        ))
          section.style.width = width > 700 ? '240px' : '';
      }, width);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate((theme) => {
        const state = window.contactOrderQa.store.getState();
        state.setPreference(theme);
        state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        state.setBackground(theme === 'light' ? 'plain' : 'grid');
      }, theme);
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        rows: [...document.querySelectorAll('.weq-directory-order')].map((toolbar) => {
          const labels = toolbar.querySelectorAll('label');
          const a = labels[0].getBoundingClientRect(),
            b = labels[1].getBoundingClientRect();
          return {
            sameRow: Math.abs(a.top - b.top) < 1,
            fits: toolbar.scrollWidth <= toolbar.clientWidth,
          };
        }),
      }));
      assert.equal(layout.overflow, false);
      assert.ok(layout.rows.every((row) => row.sameRow && row.fits));
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
      const refreshButton = page.getByRole('button', { name: '更新好友/群信息缓存', exact: true });
      assert.equal(await refreshButton.getAttribute('title'), '更新好友/群信息缓存');
      await refreshButton.click();
      const dialog = page.getByRole('dialog', { name: '更新好友/群信息缓存', exact: true });
      await dialog.waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="好友/群信息缓存更新范围"] [aria-checked="true"]')
            ?.textContent === '不更新',
      );
      const bounds = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: innerWidth,
          bodyInset:
            element.querySelector('.weq-dialog-body').getBoundingClientRect().left - rect.left,
        };
      });
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bodyInset >= 12);
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-refresh.png`) });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
    }
  await page.getByRole('button', { name: '更新好友/群信息缓存', exact: true }).click();
  await page.getByRole('button', { name: '仅刷新列表', exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('联系人分组、排序、不分组、刷新弹窗、320/390/1180px 浅深主题与同排控件验证通过');
} finally {
  await browser?.close();
  await server.close();
}
