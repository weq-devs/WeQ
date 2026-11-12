import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const stub = resolve(root, 'test/browser/requirements.stub.ts');
const image = await readFile(resolve(root, '../../resources/brand/logo.png'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-requirements'),
  plugins: [
    react(),
    tailwind(),
    {
      name: 'fixture-media',
      configureServer(server) {
        server.middlewares.use('/_media/album', (_request, response) => {
          response.setHeader('content-type', 'image/png');
          response.end(image);
        });
      },
    },
  ],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/lib\/clientPreferences$/, replacement: stub },
      { find: /^.*\/hooks\/useExportSavePolicy$/, replacement: stub },
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
  const diagnostics = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(message.text());
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/requirements.html`,
  );
  await page.getByRole('button', { name: '多选', exact: true }).click();
  await page.getByRole('button', { name: '全选已加载项', exact: true }).click();
  await page.getByRole('button', { name: '相册乙', exact: true }).click();
  await page.getByRole('button', { name: '全选已加载项', exact: true }).click();
  await page.getByRole('button', { name: '导出所选内容', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: '已选 2 项内容' }).count(), 1);
  assert.equal(await page.getByLabel('报告结果版本').locator('option').count(), 2);
  assert.equal(await page.getByRole('button', { name: '下载选中', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '编辑列表', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '开始导出', exact: true }).count(), 1);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.weq-qzal-media-thumb img')].every(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  );
  const output = process.env.WEQ_REQUIREMENTS_QA;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
      await page.evaluate((theme) => window.requirementsTheme(theme), theme);
      const colors = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--weq-accent-solid)';
        document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          actual: getComputedStyle(
            document.querySelector('.weq-reference-export .weq-exp-btn.is-primary'),
          ).backgroundColor,
          expected,
        };
      });
      assert.equal(colors.actual, colors.expected, `${width}/${theme}: primary theme`);
      assert.equal(
        await page
          .locator('.weq-reference-export .weq-exp-btn.is-primary')
          .evaluate((button) => getComputedStyle(button).transitionDuration),
        '0s',
      );
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
            .map((animation) => animation.finished.catch(() => undefined)),
        ),
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2),
        false,
        `${width}/${theme} overflow`,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
    }
  const touchContext = await browser.newContext({
    hasTouch: true,
    viewport: { width: 320, height: 800 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  try {
    const touch = await touchContext.newPage();
    touch.on('pageerror', (error) => errors.push(error.message));
    touch.on('console', (message) => {
      if (message.type() === 'error') diagnostics.push(message.text());
    });
    await touch.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await touch.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/requirements.html`,
    );
    await touch.evaluate(() => window.requirementsTheme('dark'));
    await touch.getByRole('button', { name: '多选', exact: true }).tap();
    assert.equal(await touch.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
    for (const button of await touch.locator('.weq-reference-toolbar button').all()) {
      const bounds = await button.boundingBox();
      assert.ok(bounds.width >= 44 && bounds.height >= 44);
    }
    assert.ok((await touch.getByLabel('报告结果版本').boundingBox()).height >= 44);
    assert.equal(
      await touch.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2),
      false,
    );
    if (output)
      await touch.screenshot({ path: resolve(output, '320-touch-dark.png'), fullPage: true });
  } finally {
    await touchContext.close();
  }
  await page.getByRole('checkbox', { name: /选择 相册甲的照片/ }).uncheck();
  await page.getByRole('switch', { name: '附带完整性报告', exact: true }).click();
  await page.getByRole('button', { name: '开始导出', exact: true }).click();
  await page.getByRole('dialog', { name: /到服务器/ }).waitFor();
  await page.getByRole('button', { name: /取消/ }).last().click();
  assert.equal(await page.evaluate(() => window.requirementsQa.exports.length), 0);
  await page.evaluate(() => {
    window.requirementsQa.remote = true;
  });
  await page.getByRole('button', { name: '开始导出', exact: true }).click();
  await page.waitForFunction(() => window.requirementsQa.exports.length === 1);
  const exported = await page.evaluate(() => window.requirementsQa.exports[0]);
  assert.equal(exported.items.length, 1);
  assert.equal(exported.items[0].albumId, 'album-b');
  assert.equal(exported.savePolicy.directory, '.');
  assert.equal(exported.includeIntegrityReport, true);
  await page.getByRole('button', { name: '退出多选', exact: true }).click();
  await page.getByRole('button', { name: '相册列表', exact: true }).click();
  await page.getByRole('button', { name: '选择相册 相册甲', exact: true }).click();
  await page.getByRole('button', { name: '相册乙', exact: true }).click();
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await page.getByRole('button', { name: '导出所选内容', exact: true }).click();
  await page.getByRole('button', { name: '开始导出', exact: true }).click();
  await page.waitForFunction(() => window.requirementsQa.exports.length === 2);
  assert.deepEqual(
    await page.evaluate(() =>
      window.requirementsQa.exports[1].items.map((item) => item.kind).sort(),
    ),
    ['qzone-album', 'qzone-photo'],
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(diagnostics, []);
  console.log(
    JSON.stringify({
      cases: 6,
      crossAlbum: true,
      exactExport: true,
      cancelledWebSave: true,
      remoteSavePolicy: true,
      singleSubmit: true,
      sharedAlbumAndPhotoSelection: true,
      touchTargets: true,
      themeControls: true,
      consoleErrors: diagnostics,
      pageErrors: errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
