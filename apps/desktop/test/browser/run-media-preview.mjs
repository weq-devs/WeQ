import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';
import sharp from 'sharp';
import { runMediaPreviewTouch } from './media-preview-touch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
await mkdir(resolve(root, 'node_modules/.cache'), { recursive: true });
const cache = await mkdtemp(resolve(root, 'node_modules/.cache/media-preview-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(cache, 'vite'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  optimizeDeps: {
    entries: ['test/browser/media-preview.html'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime', 'zustand'],
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/media-preview.stub.ts'),
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
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x180:rate=5',
    '-t',
    '1',
    '-c:v',
    'libvpx',
    '-an',
    resolve(cache, 'fixture.webm'),
  ]);
  const clip = await readFile(resolve(cache, 'fixture.webm'));
  const picture = await sharp({
    create: { width: 640, height: 480, channels: 3, background: '#247954' },
  })
    .png()
    .toBuffer();
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ reducedMotion: 'reduce', hasTouch: true });
  const errors = [],
    requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const mediaRoute = (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (!url.pathname.startsWith('/_media/')) return route.continue();
    requests.push(url.href);
    if (url.searchParams.get('token') === 'fail' && !url.searchParams.has('_weq_retry'))
      return route.fulfill({
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
        body: 'fixture unavailable',
      });
    if (url.pathname === '/_media/video' && url.searchParams.get('v') !== 'thumb')
      return route.fulfill({ contentType: 'video/webm', body: clip });
    return route.fulfill({ contentType: 'image/png', body: picture });
  };
  await page.route('**/*', mediaRoute);
  const output = process.env.WEQ_MEDIA_PREVIEW_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/media-preview.html`;
  let cases = 0;
  const close = async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  };
  const fits = async () => {
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const boxes = await page
      .locator('.weq-lightbox-actions button:visible, .weq-lightbox-close')
      .evaluateAll((buttons) =>
        buttons.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            right: r.right,
            bottom: r.bottom,
            width: innerWidth,
            height: innerHeight,
          };
        }),
      );
    for (const box of boxes) {
      const valid =
        box.x >= 0 && box.y >= 0 && box.right <= box.width + 1 && box.bottom <= box.height + 1;
      if (!valid && output)
        await page.screenshot({ path: resolve(output, `overflow-${box.width}.png`) });
      assert.ok(valid, JSON.stringify(box));
    }
  };
  const mousePage = await browser.newPage({ reducedMotion: 'reduce' });
  let lazyPreviewCases = 0;
  for (const [width, theme, failFirst] of [
    [390, 'dark', false],
    [320, 'light', true],
    [1280, 'dark', false],
  ]) {
    const cold = await browser.newPage({
      viewport: { width, height: 844 },
      reducedMotion: 'reduce',
    });
    cold.on('pageerror', (error) => errors.push(error.message));
    await cold.route('**/*', mediaRoute);
    let release;
    let moduleRequests = 0;
    const delayed = new Promise((done) => {
      release = done;
    });
    await cold.route('**/components/MediaPreview.tsx*', async (route) => {
      moduleRequests++;
      if (failFirst && moduleRequests === 1) return route.abort('failed');
      if (!failFirst) await delayed;
      await route.continue();
    });
    try {
      await cold.goto(url.replace('media-preview.html', 'media-preview-lazy.html'), {
        waitUntil: 'networkidle',
      });
      assert.equal(moduleRequests, 0, '未打开媒体时不能加载预览器');
      await cold.evaluate((value) => window.mediaTheme.getState().setPreference(value), theme);
      await cold.getByRole('button', { name: '打开图片', exact: true }).click();
      await cold.getByRole('dialog').waitFor();
      if (failFirst) {
        await cold.getByRole('button', { name: '重新加载预览' }).waitFor();
      } else {
        await cold.getByRole('status').waitFor();
      }
      if (output) await cold.screenshot({ path: resolve(output, `lazy-${theme}-${width}.png`) });
      if (failFirst) {
        await cold.getByRole('button', { name: '重新加载预览' }).click();
      } else {
        await cold.getByRole('button', { name: '关闭预览' }).click();
        release();
        await cold.waitForTimeout(200);
        assert.equal(await cold.getByRole('dialog').count(), 0, '迟到模块不能重开已关闭预览');
        await cold.getByRole('button', { name: '打开图片', exact: true }).click();
      }
      await cold.locator('.weq-unified-preview img').waitFor({ state: 'visible' });
      assert.equal(moduleRequests, failFirst ? 2 : 1, '失败可重新请求，成功模块复用');
      lazyPreviewCases++;
    } finally {
      release();
      await cold.close();
    }
  }
  mousePage.on('pageerror', (error) => errors.push(error.message));
  await mousePage.route('**/*', mediaRoute);
  let inlineVideoCases = 0;
  try {
    for (const width of [1280, 390]) {
      await mousePage.setViewportSize({ width, height: 844 });
      for (const theme of ['light', 'dark']) {
        await mousePage.goto(url, { waitUntil: 'networkidle' });
        await mousePage.evaluate(
          (value) => window.mediaTheme.getState().setPreference(value),
          theme,
        );
        const video = mousePage.locator('.weq-video-preview-wrap');
        const expand = video.getByRole('button', { name: '放大预览视频', exact: true });
        const hidden = () =>
          mousePage.waitForFunction(() => {
            const button = document.querySelector('.weq-video-expand');
            const style = getComputedStyle(button);
            return style.opacity === '0' && style.pointerEvents === 'none';
          });
        const shown = () =>
          mousePage.waitForFunction(() => {
            const button = document.querySelector('.weq-video-expand');
            const style = getComputedStyle(button);
            return style.opacity === '1' && style.pointerEvents === 'auto';
          });
        await video.scrollIntoViewIfNeeded();
        await mousePage.mouse.move(0, 0);
        await hidden();
        const bounds = await video.boundingBox();
        await video.hover();
        await shown();
        await expand.hover();
        await shown();
        assert.deepEqual(await video.boundingBox(), bounds);
        if (output)
          await video.screenshot({ path: resolve(output, `${theme}-${width}-inline-hover.png`) });
        await mousePage.mouse.move(0, 0);
        await hidden();
        if (output)
          await video.screenshot({ path: resolve(output, `${theme}-${width}-inline-idle.png`) });
        const play = video.getByRole('button', { name: '播放视频：video.webm', exact: true });
        await play.focus();
        await mousePage.keyboard.press('Tab');
        assert.equal(await expand.evaluate((el) => document.activeElement === el), true);
        await shown();
        await mousePage.keyboard.press('Shift+Tab');
        await shown();
        await mousePage.keyboard.press('Enter');
        await mousePage.waitForFunction(
          () => document.querySelector('.qq-media-video-player')?.readyState >= 2,
        );
        await shown();
        await mousePage.getByRole('button', { name: '背景按钮', exact: true }).click();
        await hidden();
        await video.hover();
        await shown();
        await expand.click();
        await mousePage.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
        assert.equal(await mousePage.locator('.weq-unified-preview video').count(), 1);
        await mousePage.keyboard.press('Escape');
        await mousePage.getByRole('dialog').waitFor({ state: 'detached' });
        inlineVideoCases++;
      }
    }
  } finally {
    await mousePage.close();
  }
  await page.bringToFront();
  let inlineVideoTouchCases = 0;
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate((value) => window.mediaTheme.getState().setPreference(value), theme);
      const expand = page.getByRole('button', { name: '放大预览视频', exact: true });
      assert.equal(await expand.evaluate((el) => getComputedStyle(el).opacity), '1');
      await expand.tap();
      await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
      assert.equal(await page.locator('.weq-unified-preview video').count(), 1);
      await close();
      inlineVideoTouchCases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ inlineVideoCases, inlineVideoTouchCases, lazyPreviewCases }));
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate((theme) => {
        const store = window.mediaTheme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#15653a' : '#f1d67a');
        store.setBackground(theme === 'light' ? 'paper' : 'grid');
      }, theme);
      const trigger = page.getByRole('button', { name: '打开图片', exact: true });
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
      await page.keyboard.press('+');
      assert.match(
        await page.locator('.weq-lightbox-frame').getAttribute('style'),
        /scale\(1\.25\)/,
      );
      await page.keyboard.press('ArrowRight');
      assert.match(await page.locator('.weq-lightbox-frame').getAttribute('style'), /-40px/);
      await page.getByRole('button', { name: '适应窗口', exact: true }).click();
      await page.getByRole('button', { name: 'OCR', exact: true }).click();
      await page.getByRole('button', { name: '重新识别', exact: true }).waitFor();
      await fits();
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-ocr.png`) });
      await page.getByRole('button', { name: '复制到剪贴板', exact: true }).focus();
      await page.keyboard.press('Tab');
      assert.equal(
        await page
          .locator('.weq-lightbox-layer')
          .evaluate((el) => el.contains(document.activeElement)),
        true,
      );
      await close();
      assert.equal(await trigger.evaluate((el) => document.activeElement === el), true);

      await page.getByRole('button', { name: '打开失败图片', exact: true }).click();
      await page.getByText('图片暂时无法加载', { exact: true }).waitFor();
      await fits();
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-failed.png`) });
      await page.getByRole('button', { name: '重试加载图片', exact: true }).last().click();
      await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
      assert.equal(
        await page
          .locator('.weq-lightbox-layer')
          .evaluate((el) => el.contains(document.activeElement)),
        true,
      );
      await close();

      await page.getByRole('button', { name: '打开视频', exact: true }).click();
      await page.getByText('视频暂时无法播放', { exact: true }).waitFor();
      await page.getByRole('button', { name: '重试加载视频', exact: true }).click();
      await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
      assert.equal(
        await page.locator('video.weq-lightbox-image').evaluate((el) => el.videoWidth),
        320,
      );
      await fits();
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-video.png`) });
      await close();

      const imageTrigger = page.getByRole('button', { name: '查看图片：photo.png', exact: true });
      await imageTrigger.focus();
      await page.keyboard.press('Space');
      await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
      await close();
      assert.equal(await imageTrigger.evaluate((el) => document.activeElement === el), true);
      const inlineVideo = page.getByRole('button', { name: '播放视频：video.webm', exact: true });
      await inlineVideo.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.querySelector('.qq-media-video-player')?.readyState >= 2,
      );
      assert.equal(
        await page
          .locator('.qq-media-video-player')
          .evaluate((el) => document.activeElement === el),
        true,
      );
      await page.getByRole('button', { name: '打开混排', exact: true }).click();
      await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
      assert.equal(await page.locator('.weq-preview-count').textContent(), '1 / 2');
      assert.equal(
        await page.getByRole('button', { name: '上一项媒体', exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole('button', { name: '下一项媒体', exact: true }).isEnabled(),
        true,
      );
      const viewport = await page.locator('.weq-preview-viewport').boundingBox();
      await page.mouse.click(viewport.x + 5, viewport.y + 10);
      assert.equal(await page.getByRole('dialog').count(), 1);
      await page.mouse.click(viewport.x + viewport.width - 5, viewport.y + 10);
      await page.waitForFunction(
        () => document.querySelector('.weq-unified-preview video')?.readyState >= 2,
      );
      assert.equal(await page.locator('.weq-preview-count').textContent(), '2 / 2');
      assert.equal(
        await page.getByRole('button', { name: '下一项媒体', exact: true }).isDisabled(),
        true,
      );
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('.weq-preview-count').textContent(), '2 / 2');
      assert.equal(await page.getByText('没有更新的媒体', { exact: true }).count(), 0);
      const comment = page.getByRole('textbox', { name: '媒体评论' });
      await comment.focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('.weq-preview-count').textContent(), '2 / 2');
      await page.getByRole('button', { name: '追加合成媒体', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('.weq-preview-count')?.textContent === '2 / 3',
      );
      assert.equal(await page.locator('.weq-preview-count').textContent(), '2 / 3');
      assert.equal(
        await page.getByRole('button', { name: '下一项媒体', exact: true }).isEnabled(),
        true,
      );
      await fits();
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}-mixed.png`) });
      await page.getByRole('button', { name: '下一项媒体', exact: true }).click();
      await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
      assert.equal(await page.locator('.weq-preview-count').textContent(), '3 / 3');
      const next = page.getByRole('button', { name: '下一项媒体', exact: true });
      assert.equal(await next.isDisabled(), true);
      assert.equal(await next.evaluate((el) => getComputedStyle(el).opacity), '0.3');
      if (output)
        await page.screenshot({ path: resolve(output, `${theme}-${width}-boundary.png`) });
      await close();
      await page.getByRole('button', { name: '打开表情包', exact: true }).click();
      await page.locator('.weq-mface-lb-cell').click();
      await page.locator('.weq-mface-detail').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.weq-mface-lb-grid').waitFor();
      await close();
      cases++;
    }
  }
  await page.getByRole('button', { name: '打开渐进图片', exact: true }).click();
  await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
  assert.ok(
    await page
      .locator('.weq-unified-preview img')
      .evaluate(
        (image) => image.complete && image.naturalWidth === 640 && image.src.includes('v=thumb'),
      ),
  );
  const thumbnailPixels = await sharp(
    await page.locator('.weq-unified-preview img').screenshot(),
  ).stats();
  assert.ok(thumbnailPixels.channels[1].mean > 80);
  assert.equal(requests.filter((value) => value.includes('token=progressiveFull')).length, 0);
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await page.evaluate(() => window.releasePreviewDetail());
  await page.waitForFunction(() =>
    document.querySelector('.weq-unified-preview img')?.src.includes('token=progressiveFull'),
  );
  await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
  assert.match(await page.locator('.weq-lightbox-frame').getAttribute('style'), /scale\(1\.25\)/);
  await close();
  // 在真实 Chromium 事件循环中合成单指拖动和取消，验证可继续下一次手势。
  await page.getByRole('button', { name: '打开图片', exact: true }).click();
  await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await page.locator('.weq-lightbox-frame').evaluate((el) => {
    const send = (target, type, x) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          isPrimary: true,
          pointerType: 'touch',
          clientX: x,
          clientY: 10,
        }),
      );
    // 合成事件没有平台活动指针，不请求平台 capture；单测另覆盖取消与丢失捕获。
    el.setPointerCapture = () => {};
    send(el, 'pointerdown', 10);
    send(window, 'pointermove', 40);
    send(window, 'pointercancel', 40);
  });
  assert.match(await page.locator('.weq-lightbox-frame').getAttribute('style'), /30px/);
  await close();
  const touchCases = await runMediaPreviewTouch(page, output);
  assert.deepEqual(errors, []);
  assert.ok(requests.some((value) => value.includes('_weq_retry=1')));
  console.log(
    JSON.stringify({
      cases,
      inlineVideoCases,
      inlineVideoTouchCases,
      touchCases,
      errors,
      mediaRequests: requests.length,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
  await rm(cache, { recursive: true, force: true });
}
