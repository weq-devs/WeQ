import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_EXTRAS_QA;
const live = process.env.WEQ_PROFILE_EXTRAS_IMAGES;
const blobs = live
  ? await Promise.all([0, 1].map((index) => readFile(resolve(live, `photo-${index}.image`))))
  : [];
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-profile-extras'),
  plugins: [
    react(),
    tailwind(),
    {
      name: 'profile-extras-images',
      configureServer(server) {
        server.middlewares.use('/_media/album', (req, res) => {
          const src = new URL(req.url, 'http://localhost').searchParams.get('src') ?? '';
          const blob = blobs[src.endsWith('-1') ? 1 : 0];
          if (!blob) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader('Content-Type', blob[0] === 0xff ? 'image/jpeg' : 'image/png');
          res.end(blob);
        });
      },
    },
  ],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/profile-extras.stub.ts'),
      },
      {
        find: /^.*\/hooks\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/profile-extras.stub.ts'),
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
const results = [];
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
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-extras.html`;
  if (output) await mkdir(output, { recursive: true });
  await page.goto(`${url}?mode=loading`);
  await page.locator('[data-local-signature]').waitFor();
  assert.ok((await page.locator('main').textContent()).includes('读取中'));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  if (output) await page.screenshot({ path: resolve(output, 'first-paint-loading.png') });
  results.push({ firstPaint: 'local-content-present-while-query-loading' });
  await page.evaluate(() => window.profileExtrasQa.mode('ready'));
  await page.getByText('831', { exact: true }).waitFor();
  await page.getByRole('button', { name: '历史签名', exact: true }).click();
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.getByText('第二页签名', { exact: true }).waitFor();
  const firstSignature = page.locator('.weq-extras-list > article').first();
  await firstSignature.getByRole('button', { name: '点赞签名', exact: true }).click();
  await firstSignature.getByRole('button', { name: '取消签名点赞', exact: true }).waitFor();
  await firstSignature.getByRole('button', { name: '取消签名点赞', exact: true }).click();
  await firstSignature.getByRole('button', { name: '评论', exact: true }).click();
  await firstSignature.getByRole('button', { name: '回复评论', exact: true }).click();
  await firstSignature.getByLabel('签名评论').fill('合成回复验收');
  await page.evaluate(() => window.profileExtrasQa.failNext('signatureComment'));
  await firstSignature.getByRole('button', { name: '发送评论', exact: true }).click();
  await firstSignature.getByText('合成操作失败').waitFor();
  assert.equal(await firstSignature.getByLabel('签名评论').inputValue(), '合成回复验收');
  await firstSignature.getByRole('button', { name: '发送评论', exact: true }).click();
  await firstSignature
    .getByRole('button', { name: '删除评论：合成回复验收', exact: true })
    .waitFor();
  assert.equal(await firstSignature.getByLabel('签名评论').inputValue(), '');
  await firstSignature.getByRole('button', { name: '删除评论：合成回复验收', exact: true }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await firstSignature
    .getByRole('button', { name: '删除评论：合成回复验收', exact: true })
    .waitFor({ state: 'detached' });
  assert.ok((await firstSignature.textContent()).includes('合成昵称等 28 人点赞'));
  if (output) await page.screenshot({ path: resolve(output, 'signature-interactions.png') });
  results.push({
    signatureLikeToggle: true,
    reply: true,
    failedDraftRetained: true,
    deletion: true,
  });
  await page.getByRole('button', { name: '关闭资料详情' }).click();
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark'])
      for (const accent of ['#167d67', '#a82555']) {
        await page.setViewportSize({ width, height: 850 });
        await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
        await page.evaluate(
          ({ theme, accent }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.setProperty('--weq-accent-effective', accent);
          },
          { theme, accent },
        );
        for (const mode of ['ready', 'loading', 'empty', 'error']) {
          await page.evaluate((mode) => window.profileExtrasQa.mode(mode), mode);
          await page.getByRole('button', { name: '匿问我答', exact: true }).click();
          const overflow = await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                '.weq-extras-dialog, .weq-extras-header, .weq-extras-content, .weq-extras-list p, .weq-extras-list h3, .weq-extras-summary',
              ),
            ]
              .filter((el) => el.scrollWidth > el.clientWidth + 2)
              .map((el) => el.className),
          );
          assert.deepEqual(overflow, [], `${width}/${theme}/${mode}: overflow`);
          if (output && accent === '#167d67')
            await page.screenshot({ path: resolve(output, `${width}-${theme}-${mode}.png`) });
          results.push({ width, theme, accent, mode, overflow: false });
          await page.getByRole('button', { name: '关闭资料详情' }).click();
          await page.getByRole('button', { name: '教育经历', exact: true }).click();
          if (mode === 'ready') {
            assert.equal(await page.locator('.weq-education-list article').count(), 2);
            assert.ok(
              (await page.locator('.weq-extras-content').textContent()).includes(
                '2019 年入学 · 2023 年毕业',
              ),
            );
          }
          const educationOverflow = await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                '.weq-extras-dialog, .weq-extras-content, .weq-education-list article, .weq-education-list h3, .weq-education-list p',
              ),
            ].some((element) => element.scrollWidth > element.clientWidth + 2),
          );
          assert.equal(educationOverflow, false, `${width}/${theme}/${mode}: education overflow`);
          if (output && accent === '#167d67' && mode === 'ready')
            await page.screenshot({ path: resolve(output, `${width}-${theme}-education.png`) });
          results.push({ width, theme, accent, mode, view: 'education', overflow: false });
          await page.getByRole('button', { name: '关闭资料详情' }).click();
          await page.getByRole('button', { name: '详细资料', exact: true }).click();
          if (mode === 'ready') {
            assert.equal(await page.locator('.weq-profile-details-list article').count(), 3);
            assert.ok(
              (await page.locator('.weq-profile-details-list').textContent()).includes(
                '第二行说明',
              ),
            );
          }
          if (mode === 'empty') {
            assert.ok(
              (await page.locator('.weq-profile-details-list').textContent()).includes('未填写'),
            );
            assert.ok(
              (await page.locator('.weq-profile-details-list').textContent()).includes('未返回'),
            );
          }
          const detailsOverflow = await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                '.weq-extras-dialog, .weq-extras-content, .weq-profile-details-list article, .weq-profile-details-list p',
              ),
            ].some((element) => element.scrollWidth > element.clientWidth + 2),
          );
          assert.equal(detailsOverflow, false, `${width}/${theme}/${mode}: details overflow`);
          if (output && accent === '#167d67' && mode === 'ready')
            await page.screenshot({ path: resolve(output, `${width}-${theme}-details.png`) });
          results.push({ width, theme, accent, mode, view: 'details', overflow: false });
          await page.getByRole('button', { name: '关闭详细资料' }).click();
        }
      }
  await page.evaluate(() => window.profileExtrasQa.mode('ready'));
  await page.getByRole('button', { name: '匿问我答', exact: true }).click();
  await page.locator('.weq-profile-question-open').click();
  await page.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await page.getByText('末页评论', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: '加载更多评论', exact: true }).count(), 0);
  for (const width of [1180, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      const overflow = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '.weq-profile-interactions, .weq-profile-comments li, .weq-profile-interaction-bar',
          ),
        ].some((el) => el.scrollWidth > el.clientWidth + 2),
      );
      assert.equal(overflow, false);
      if (output)
        await page.screenshot({
          path: resolve(output, `${width}-${theme}-question-interactions.png`),
        });
    }
  await page.getByRole('button', { name: '关闭资料详情' }).click();
  results.push({ questionDetail: true, finalCommentsRetained: true });
  await page.getByRole('button', { name: '标签相册', exact: true }).click();
  await page.getByRole('button', { name: '合成标签相册' }).click();
  const fileChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加照片', exact: true }).click();
  await (await fileChooser).setFiles([
    { name: 'fixture-one.png', mimeType: 'image/png', buffer: Buffer.from('one') },
    { name: 'fixture-two.png', mimeType: 'image/png', buffer: Buffer.from('two') },
  ]);
  await page.getByText('fixture-two.png', { exact: true }).waitFor();
  await page.evaluate(() => window.profileExtrasQa.failNext('personalityPhotoUpload'));
  await page.getByRole('button', { name: '上传', exact: true }).click();
  await page.getByRole('button', { name: '上传待完成照片', exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.weq-profile-upload-list small')].filter(
        (el) => el.textContent === '已上传',
      ).length === 1,
  );
  assert.equal(
    await page
      .locator('.weq-profile-upload-list small')
      .filter({ hasText: /^已上传$/ })
      .count(),
    1,
  );
  await page.getByRole('button', { name: '上传待完成照片', exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.weq-profile-upload-list small')].every(
      (el) => el.textContent === '已上传',
    ),
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.profileExtrasQa.operations.filter((op) => op === 'personalityPhotoUpload').length,
    ),
    2,
  );
  assert.equal(
    await page.evaluate(
      () => window.profileExtrasQa.operations.filter((op) => op === 'discard').length,
    ),
    3,
  );
  if (output) await page.screenshot({ path: resolve(output, 'photo-batch-upload.png') });
  results.push({ multiplePhotos: 2, retryFailedOnly: true, stagedFilesDiscarded: 3 });
  if (blobs.length) {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.weq-extras-photos img')].length === 2 &&
        [...document.querySelectorAll('.weq-extras-photos img')].every(
          (img) => img.complete && img.naturalWidth > 1,
        ),
    );
    await page.getByRole('button', { name: '查看第 1 张照片' }).click();
    await page.waitForFunction(() => {
      const img = document.querySelector('.weq-unified-preview img');
      return img?.complete && img.naturalWidth > 1;
    });
    const firstSource = await page.locator('.weq-unified-preview img').evaluate((img) => img.src);
    const pixelColors = await page.evaluate(() => {
      const img = document.querySelector('.weq-unified-preview img');
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0, 16, 16);
      const data = context.getImageData(0, 0, 16, 16).data;
      return new Set(
        Array.from(
          { length: 256 },
          (_, i) => `${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]}`,
        ),
      ).size;
    });
    assert.ok(pixelColors > 4, 'live image must contain nonblank pixels');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((src) => {
      const img = document.querySelector('.weq-unified-preview img');
      return img?.src !== src && img?.complete && img.naturalWidth > 1;
    }, firstSource);
    if (output) await page.screenshot({ path: resolve(output, 'live-photo-preview.png') });
    await page.keyboard.press('Escape');
    await page.locator('.weq-unified-preview').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: '关闭资料详情' }).count(), 1);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '关闭资料详情' }).waitFor({ state: 'detached' });
    results.push({
      liveImages: 2,
      decoded: true,
      pixelColors,
      keyboardNext: true,
      escapeOnlyTop: true,
    });
  }
  assert.deepEqual(errors, []);
  if (output)
    await writeFile(resolve(output, 'result.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ cases: results.length, errors, liveImages: blobs.length }));
} finally {
  await browser?.close();
  await server.close();
}
