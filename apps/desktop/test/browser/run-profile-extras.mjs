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
const albumOnly = process.argv.includes('--label-album');
const signaturesOnly = process.argv.includes('--signatures');
const live = process.env.WEQ_PROFILE_EXTRAS_IMAGES;
const blobs = live
  ? await Promise.all([0, 1].map((index) => readFile(resolve(live, `photo-${index}.image`))))
  : albumOnly
    ? await Promise.all(
        [0, 1].map(() => readFile(resolve(root, '../../resources/qqlevel/penguin.png'))),
      )
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
async function run() {
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
    if (!albumOnly) {
      await page.goto(`${url}?mode=loading`);
      await page.locator('[data-local-signature]').waitFor();
      assert.ok((await page.locator('main').textContent()).includes('读取中'));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      if (output) await page.screenshot({ path: resolve(output, 'first-paint-loading.png') });
      results.push({ firstPaint: 'local-content-present-while-query-loading' });
      await page.evaluate(() => window.profileExtrasQa.mode('ready'));
      await page.getByText('831', { exact: true }).waitFor();
      await page.getByRole('button', { name: '历史签名', exact: true }).click();
      assert.equal(await page.locator('[aria-modal="true"]').count(), 0);
      assert.equal(await page.locator('.weq-dialog-layer.is-anchored-popover').count(), 1);
      await page.getByRole('button', { name: '加载更多', exact: true }).click();
      await page.getByText('第二页签名', { exact: true }).waitFor();
      const firstSignature = page.locator('.weq-extras-list > article').first();
      await firstSignature.getByRole('button', { name: '点赞签名', exact: true }).click();
      await firstSignature.getByRole('button', { name: '取消签名点赞', exact: true }).waitFor();
      await firstSignature.getByRole('button', { name: '取消签名点赞', exact: true }).click();
      await firstSignature.getByRole('button', { name: '评论', exact: true }).click();
      await firstSignature.locator('.weq-qzn-comment .weq-identity-link strong').first().click();
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.profileTarget),
        '10001',
      );
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
      await firstSignature
        .getByRole('button', { name: '删除评论：合成回复验收', exact: true })
        .click();
      await page.getByRole('button', { name: '确定', exact: true }).click();
      await firstSignature
        .getByRole('button', { name: '删除评论：合成回复验收', exact: true })
        .waitFor({ state: 'detached' });
      await firstSignature.getByRole('button', { name: '点赞签名', exact: true }).hover();
      await page.getByRole('region', { name: '点赞列表' }).waitFor();
      const signatureLiker = page
        .getByRole('region', { name: '点赞列表' })
        .locator('.weq-identity-link')
        .first();
      assert.equal(
        await signatureLiker.locator('.weq-avatar-img, .weq-avatar-fallback').count(),
        1,
      );
      const signatureLikerMarkup = await signatureLiker.evaluate((node) => node.outerHTML);
      await signatureLiker.locator('span').last().click();
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.profileTarget),
        '10002',
        signatureLikerMarkup,
      );
      assert.match(
        await page
          .getByRole('region', { name: '点赞列表' })
          .locator('.weq-profile-like-summary')
          .textContent(),
        /^28 人赞过$/,
      );
      if (output) await page.screenshot({ path: resolve(output, 'signature-interactions.png') });
      results.push({
        signatureLikeToggle: true,
        reply: true,
        failedDraftRetained: true,
        deletion: true,
      });
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
            await firstSignature.getByRole('button', { name: '点赞签名', exact: true }).hover();
            await page.getByRole('region', { name: '点赞列表' }).waitFor();
            const overflow = await page.evaluate(() =>
              [
                ...document.querySelectorAll(
                  '.weq-signature-interactions, .weq-qzn-actions, .weq-qzn-comment, .weq-qzn-like-popover, .weq-profile-comment-form',
                ),
              ]
                .filter((node) => node.scrollWidth > node.clientWidth + 2)
                .map((node) => node.className),
            );
            assert.deepEqual(overflow, [], `${width}/${theme}/${accent}: signature overflow`);
            const layout = await page.locator('.weq-signature-history-dialog').evaluate((node) => {
              const rect = node.getBoundingClientRect();
              const layer = getComputedStyle(node.parentElement);
              return {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                background: layer.backgroundColor,
                pointerEvents: layer.pointerEvents,
              };
            });
            assert.ok(layout.left >= 8 && layout.right <= width - 8);
            assert.ok(layout.top >= 8 && layout.bottom <= 842);
            assert.equal(layout.background, 'rgba(0, 0, 0, 0)');
            assert.equal(layout.pointerEvents, 'none');
            assert.equal(await firstSignature.locator('.weq-qzn-comment-meta time').count(), 1);
            assert.equal(
              await firstSignature.getByRole('button', { name: '点赞人', exact: true }).count(),
              0,
            );
            if (output && accent === '#167d67')
              await page.screenshot({ path: resolve(output, `${width}-${theme}-signatures.png`) });
            await page.mouse.move(1, 1);
            await page.getByRole('region', { name: '点赞列表' }).waitFor({ state: 'detached' });
            if (output && accent === '#167d67')
              await page.screenshot({
                path: resolve(output, `${width}-${theme}-signature-comments.png`),
              });
            results.push({ width, theme, accent, signatureLayout: true });
          }
      if (signaturesOnly) {
        await page.getByRole('button', { name: '关闭资料详情', exact: true }).click();
        const trigger = page.getByRole('button', { name: '历史签名', exact: true });
        for (const width of [1180, 320]) {
          await page.setViewportSize({ width, height: 500 });
          await trigger.evaluate((node) => {
            Object.assign(node.style, { position: 'fixed', right: '12px', bottom: '12px' });
          });
          await trigger.click();
          const dialog = page.locator('.weq-signature-history-dialog');
          await dialog.waitFor();
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          const bounds = await dialog.boundingBox();
          const anchor = await trigger.boundingBox();
          const evidence = JSON.stringify({ width, bounds, anchor });
          assert.ok(bounds.x >= 8 && bounds.x + bounds.width <= width - 8, evidence);
          assert.ok(bounds.y >= 8 && bounds.y + bounds.height <= 492, evidence);
          if (width === 1180) assert.ok(Math.abs(bounds.x + bounds.width - anchor.x + 8) <= 1);
          await trigger.click();
          await dialog.waitFor({ state: 'detached' });
          await trigger.press('Enter');
          await dialog.waitFor();
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
          assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
          await trigger.click();
          await dialog.waitFor();
          await page.mouse.click(4, 4);
          await dialog.waitFor({ state: 'detached' });
          results.push({ width, edgePlacement: true, toggle: true, escape: true, outside: true });
        }
        assert.deepEqual(errors, []);
        if (output)
          await writeFile(
            resolve(output, 'result.json'),
            JSON.stringify({ results, errors }, null, 2),
          );
        console.log(JSON.stringify({ cases: results.length, errors, signatures: true }));
        return;
      }
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
                assert.equal(await page.locator('.weq-education-record').count(), 2);
                assert.ok(
                  (await page.locator('.weq-extras-content').textContent()).includes(
                    '2019 年入学 · 2023 年毕业',
                  ),
                );
              }
              const educationOverflow = await page.evaluate(() =>
                [
                  ...document.querySelectorAll(
                    '.weq-extras-dialog, .weq-extras-content, .weq-education-record, .weq-education-record .weq-profile-data-value',
                  ),
                ].some((element) => element.scrollWidth > element.clientWidth + 2),
              );
              assert.equal(
                educationOverflow,
                false,
                `${width}/${theme}/${mode}: education overflow`,
              );
              if (output && accent === '#167d67' && mode === 'ready')
                await page.screenshot({ path: resolve(output, `${width}-${theme}-education.png`) });
              results.push({ width, theme, accent, mode, view: 'education', overflow: false });
              await page.getByRole('button', { name: '关闭资料详情' }).click();
              await page.getByRole('button', { name: '详细资料', exact: true }).click();
              if (mode === 'ready') {
                assert.equal(
                  await page.locator('.weq-extras-content .weq-profile-data-row').count(),
                  3,
                );
                assert.ok(
                  (
                    await page.locator('.weq-extras-content .weq-profile-data').textContent()
                  ).includes('第二行说明'),
                );
              }
              if (mode === 'empty') {
                assert.ok(
                  (
                    await page.locator('.weq-extras-content .weq-profile-data').textContent()
                  ).includes('未填写'),
                );
                assert.ok(
                  (
                    await page.locator('.weq-extras-content .weq-profile-data').textContent()
                  ).includes('未返回'),
                );
              }
              const detailsOverflow = await page.evaluate(() =>
                [
                  ...document.querySelectorAll(
                    '.weq-extras-dialog, .weq-extras-content, .weq-profile-data-row, .weq-profile-data-value',
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
      assert.equal(
        await page.getByRole('button', { name: '加载更多评论', exact: true }).count(),
        0,
      );
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
    } else {
      await page.goto(url);
    }
    await page.getByRole('button', { name: '合成标签相册' }).click();
    assert.equal(await page.locator('[aria-modal="true"]').count(), 0);
    assert.equal(await page.getByText('全部标签', { exact: true }).count(), 0);
    const labelLikes = page.getByLabel('标签点赞列表');
    assert.equal(await labelLikes.locator('.weq-profile-label-like-name').count(), 4);
    assert.equal(await labelLikes.locator('button').count(), 4);
    assert.equal(await labelLikes.locator('[aria-pressed]').count(), 0);
    const firstLiker = labelLikes.getByRole('button', {
      name: '查看 合成昵称 的名片',
      exact: true,
    });
    for (const selector of [
      '.weq-avatar-img, .weq-avatar-fallback',
      '.weq-profile-label-like-name',
    ]) {
      await page.evaluate(() => delete document.documentElement.dataset.profileTarget);
      await firstLiker.locator(selector).click();
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.profileTarget),
        '10002',
      );
    }
    await page.evaluate(() => delete document.documentElement.dataset.profileTarget);
    await firstLiker.focus();
    await page.keyboard.press('Enter');
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.profileTarget),
      '10002',
    );
    assert.equal(await page.locator('.weq-label-album').count(), 1);
    assert.equal(
      await labelLikes.locator('.weq-profile-label-like-total').textContent(),
      '等 28 人点赞',
    );
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
          const layout = await page.locator('.weq-label-album').evaluate((album) => {
            const rect = album.getBoundingClientRect();
            const photo = album.querySelector('.weq-extras-photos button').getBoundingClientRect();
            const layer = getComputedStyle(album.parentElement);
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              photoSize: photo.width,
              overflow: album.scrollWidth > album.clientWidth + 2,
              background: layer.backgroundColor,
              pointerEvents: layer.pointerEvents,
              columns: getComputedStyle(
                album.querySelector('.weq-extras-photos'),
              ).gridTemplateColumns.split(' ').length,
            };
          });
          assert.ok(layout.left >= 8 && layout.right <= width - 8);
          assert.ok(layout.top >= 8 && layout.bottom <= 842);
          assert.ok(layout.photoSize >= 55 && layout.photoSize <= 84);
          assert.equal(layout.columns, 4);
          assert.equal(layout.overflow, false);
          assert.equal(layout.background, 'rgba(0, 0, 0, 0)');
          assert.equal(layout.pointerEvents, 'none');
          const likesLayout = await labelLikes.evaluate((list) => {
            const rect = list.getBoundingClientRect();
            return {
              overflow: list.scrollWidth > list.clientWidth + 2,
              outside: [...list.children].some((child) => {
                const item = child.getBoundingClientRect();
                return item.left < rect.left - 1 || item.right > rect.right + 1;
              }),
              avatars: list.querySelectorAll('.weq-avatar-img, .weq-avatar-fallback').length,
              avatarSize: list
                .querySelector('.weq-avatar-img, .weq-avatar-fallback')
                .getBoundingClientRect().width,
            };
          });
          assert.equal(likesLayout.overflow, false);
          assert.equal(likesLayout.outside, false);
          assert.equal(likesLayout.avatars, 4);
          assert.equal(likesLayout.avatarSize, 20);
          const anchor = await page
            .getByRole('button', { name: '合成标签相册', exact: true })
            .boundingBox();
          assert.ok(Math.abs(layout.top - anchor.y - anchor.height - 8) <= 1);
          if (output && accent === '#167d67')
            await page.screenshot({ path: resolve(output, `${width}-${theme}-label-album.png`) });
          results.push({ width, theme, accent, album: layout });
        }
    const fileChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '添加照片', exact: true }).click();
    await (await fileChooser).setFiles([
      { name: 'fixture-one.png', mimeType: 'image/png', buffer: Buffer.from('one') },
      { name: 'fixture-two.png', mimeType: 'image/png', buffer: Buffer.from('two') },
    ]);
    await page.getByText('fixture-two.png', { exact: true }).waitFor();
    for (const width of [320, 1180]) {
      await page.setViewportSize({ width, height: 850 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          const store = window.profileExtrasTheme.getState();
          store.setPreference(theme);
          store.setAccent('#a82555');
        }, theme);
        const buttons = page.locator('.weq-profile-interaction-bar').last();
        const appearances = await buttons.locator('button').evaluateAll((nodes) =>
          nodes.map((node) => {
            const style = getComputedStyle(node);
            return { color: style.color, background: style.backgroundColor, size: style.fontSize };
          }),
        );
        assert.equal(appearances.length, 2);
        assert.equal(appearances[0].size, '13px');
        assert.equal(appearances[1].size, '13px');
        assert.notEqual(appearances[0].background, appearances[1].background);
        assert.equal(
          await buttons.evaluate((node) => node.scrollWidth > node.clientWidth + 1),
          false,
        );
        if (output)
          await page.screenshot({
            path: resolve(output, `${width}-${theme}-photo-upload-ready.png`),
          });
      }
    }
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
      assert.equal(await page.getByRole('button', { name: '关闭标签相册' }).count(), 1);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '关闭标签相册' }).waitFor({ state: 'detached' });
      results.push({
        liveImages: 2,
        decoded: true,
        pixelColors,
        keyboardNext: true,
        escapeOnlyTop: true,
      });
    }
    if (!(await page.locator('.weq-label-album').count()))
      await page.getByRole('button', { name: '合成标签相册', exact: true }).click();
    await page.locator('.weq-label-album').waitFor();
    await page.mouse.click(4, 800);
    await page.locator('.weq-label-album').waitFor({ state: 'detached' });
    results.push({ outsideDismiss: true });
    assert.deepEqual(errors, []);
    if (output)
      await writeFile(resolve(output, 'result.json'), JSON.stringify({ results, errors }, null, 2));
    console.log(JSON.stringify({ cases: results.length, errors, liveImages: blobs.length }));
  } finally {
    await browser?.close();
    await server.close();
  }
}
await run();
