import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
await mkdir(resolve(root, 'node_modules/.cache'), { recursive: true });
const cache = await mkdtemp(resolve(root, 'node_modules/.cache/video-preview-loading-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(cache, 'vite'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
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
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
  const output = process.env.WEQ_MEDIA_PREVIEW_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const errors = [];
  let cases = 0;
  for (const width of [1280, 390, 320]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        reducedMotion: 'reduce',
      });
      let releaseVideo;
      const pendingVideo = new Promise((done) => {
        releaseVideo = done;
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== '127.0.0.1') return route.abort();
        if (!url.pathname.startsWith('/_media/')) return route.continue();
        if (url.pathname === '/_media/video' && url.searchParams.get('v') !== 'thumb') {
          if (url.searchParams.get('token') === 'fail' && !url.searchParams.has('_weq_retry'))
            return route.fulfill({ status: 404, body: 'fixture unavailable' });
          await pendingVideo;
          return route.fulfill({ contentType: 'video/webm', body: clip });
        }
        return route.fulfill({ contentType: 'image/png', body: picture });
      });
      try {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/media-preview.html`,
        );
        await page.evaluate((value) => {
          const store = window.mediaTheme.getState();
          store.setPreference(value);
          store.setAccent(value === 'light' ? '#15653a' : '#f1d67a');
          store.setBackground(value === 'light' ? 'paper' : 'grid');
        }, theme);
        await page.getByRole('button', { name: '打开视频', exact: true }).click();
        await page.getByText('视频暂时无法播放', { exact: true }).waitFor();
        const videoRequested = page.waitForRequest((request) => {
          const url = new URL(request.url());
          return url.pathname === '/_media/video' && url.searchParams.get('_weq_retry') === '1';
        });
        await page.getByRole('button', { name: '重试加载视频', exact: true }).click();
        await videoRequested;
        const stage = page.locator('.weq-lightbox-stage[data-media-state="loading"]');
        await stage.waitFor();
        // 等待原生播放器绘制加载动画，覆盖真实慢请求而非最终就绪状态。
        await page.waitForTimeout(1200);
        if (output)
          await page.screenshot({ path: resolve(output, `${theme}-${width}-video-loading.png`) });
        assert.equal(await stage.getAttribute('aria-busy'), 'true');
        assert.equal(await stage.locator('video[controls]').count(), 1);
        assert.equal(await stage.locator('.weq-media-load-status').count(), 0);
        releaseVideo();
        await page.locator('.weq-lightbox-stage[data-media-state="ready"]').waitFor();
        assert.equal(
          await page.locator('.weq-unified-preview video').evaluate((el) => el.videoWidth),
          320,
        );
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        cases++;
      } finally {
        releaseVideo();
        await page.close();
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
  await rm(cache, { recursive: true, force: true });
}
