import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-field-history'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/field-history.stub.ts'),
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
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/_media/') || url.pathname.startsWith('/_avatar/'))
      return route.fulfill({
        path: resolve(root, '../../resources/fileicon/image.png'),
        contentType: 'image/png',
      });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/field-history.html`,
  );
  await page.locator('.weq-field-trend').waitFor();
  const output = process.env.WEQ_FIELD_HISTORY_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        window.fieldHistoryQa.theme.getState().setPreference(theme);
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#e5b969' : '#007a61',
        );
      }, theme);
      for (const field of [
        'likes',
        'memberCount',
        'birthday',
        'signature',
        'role',
        'labels',
        'commonGroups',
        'school',
        'marks',
        'dress',
        'privileges',
        'questions',
        'photos',
        'qqShow',
        'avatar',
      ]) {
        await page.evaluate((field) => window.fieldHistoryQa.setField(field), field);
        await page.waitForFunction(
          (field) =>
            document.querySelector('.weq-field-presentation')?.getAttribute('data-field') === field,
          field,
        );
        await page.locator(`.weq-field-presentation`).waitFor();
        await page.waitForFunction(
          (field) =>
            document
              .querySelector('.weq-field-presentation')
              ?.classList.contains(
                `is-${['likes', 'memberCount'].includes(field) ? 'trend' : ['avatar', 'photos', 'qqShow'].includes(field) ? 'gallery' : ['birthday', 'signature', 'role'].includes(field) ? 'changes' : 'collection'}`,
              ),
          field,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${width} ${theme} ${field} 页面溢出`,
        );
        assert.equal(
          await page
            .locator('.weq-field-history-body')
            .evaluate((el) => el.scrollWidth > el.clientWidth),
          false,
          `${width} ${theme} ${field} 内容溢出`,
        );
        if (['likes', 'memberCount'].includes(field)) {
          assert.ok(await page.locator('.weq-field-chart-line').getAttribute('d'));
          assert.equal(
            await page
              .locator('.weq-field-chart-line')
              .evaluate((el) => getComputedStyle(el).stroke),
            theme === 'dark' ? 'rgb(229, 185, 105)' : 'rgb(0, 122, 97)',
          );
        }
        if (['photos', 'avatar', 'qqShow'].includes(field)) {
          await page.waitForFunction(() =>
            [...document.querySelectorAll('img')].every(
              (img) => img.complete && img.naturalWidth > 0,
            ),
          );
          const image = page.locator('.weq-field-presentation img').first();
          assert.ok((await image.boundingBox()).height > 0);
          await image.click();
          await page.getByRole('dialog').waitFor();
          await page.keyboard.press('Escape');
          await page.getByRole('dialog').waitFor({ state: 'detached' });
        }
        if (output && ['likes', 'commonGroups', 'signature', 'photos', 'marks'].includes(field))
          await page.screenshot({
            path: resolve(output, `${width}-${theme}-${field}.png`),
            animations: 'disabled',
          });
      }
    }
  await page.evaluate(() => window.fieldHistoryQa.setField('empty'));
  await page.getByText('暂无这项资料的历史记录', { exact: true }).waitFor();
  if (process.env.WEQ_FIELD_HISTORY_FIXTURES) {
    const fixtures = JSON.parse(await readFile(process.env.WEQ_FIELD_HISTORY_FIXTURES, 'utf8'));
    for (const { field, rows } of fixtures) {
      await page.evaluate(({ field, rows }) => window.fieldHistoryQa.setRecords(field, rows), {
        field,
        rows,
      });
      await page.waitForFunction(
        (field) =>
          document.querySelector('.weq-field-presentation')?.getAttribute('data-field') === field,
        field,
      );
      await page.waitForFunction((count) => {
        const shown = document.querySelectorAll('.weq-field-records > li').length;
        return count ? shown > 0 && shown <= count : shown === 0;
      }, rows.length);
      assert.equal(
        await page
          .locator('.weq-field-history-body')
          .evaluate((el) => el.scrollWidth > el.clientWidth),
        false,
        `本机 ${field} 内容溢出`,
      );
      assert.equal(
        await page.getByText('未识别的旧资料', { exact: true }).count(),
        0,
        `本机 ${field} 未识别`,
      );
      if (output && ['likes', 'commonGroups', 'marks', 'school'].includes(field))
        await page.screenshot({
          path: resolve(output, `local-${field}.png`),
          animations: 'disabled',
        });
    }
    console.log(`本机真实历史：${fixtures.length} 类字段回读与渲染通过`);
  }
  assert.deepEqual(errors, []);
  console.log(
    '字段历史：15 种场景 × 3 个宽度 × 深浅主题、主题色、零值与缺值、图片渲染及放大、空状态通过',
  );
} finally {
  await browser?.close();
  await server.close();
}
