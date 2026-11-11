import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

// 离线浏览器回归：用 ffmpeg 合成视频，不读取账号数据或请求 CDN。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_HOME_BACKDROP_QA;
const videoBytes = execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=180x320:rate=24',
  '-t',
  '2',
  '-c:v',
  'libvpx',
  '-f',
  'webm',
  'pipe:1',
]);
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/home-backdrop.stub.ts'),
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
    if (url.pathname === '/_media/dress')
      return route.fulfill({ contentType: 'video/webm', body: videoBytes });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  const report = [];
  if (output) await mkdir(output, { recursive: true });
  for (const [width, height, theme, reducedMotion] of [
    [1000, 700, 'light', 'no-preference'],
    [390, 400, 'dark', 'no-preference'],
    [390, 240, 'light', 'no-preference'],
    [390, 844, 'dark', 'reduce'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/home-backdrop.html`,
    );
    await page.locator('video').waitFor({ state: 'attached' });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty(
        '--weq-accent-effective',
        theme === 'dark' ? '#47bc97' : '#c64556',
      );
    }, theme);
    const sample = await page.evaluate(async () => {
      const home = document.querySelector('.weq-chathome');
      const video = document.querySelector('video');
      const scroller = home.querySelector('.weq-chathome-content') ?? home;
      const samples = [];
      const start = performance.now();
      while (performance.now() - start < 6000) {
        await new Promise(requestAnimationFrame);
        // 覆盖入场动画尚未结束时滚动，以及逐字换行后继续滚动。
        scroller.scrollTop = samples.length % 60 < 30 ? scroller.scrollHeight : 0;
        samples.push({
          y: video.getBoundingClientRect().y,
          height: video.getBoundingClientRect().height,
          scroll: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
        });
      }
      return {
        positions: [...new Set(samples.map((s) => s.y))],
        scrolls: [...new Set(samples.map((s) => s.scroll))],
        heights: [...new Set(samples.map((s) => s.height))],
        scrollHeights: [...new Set(samples.map((s) => s.scrollHeight))],
        frames: video.getVideoPlaybackQuality().totalVideoFrames,
        rate: video.playbackRate,
        paused: video.paused,
        viewportOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    report.push({ width, height, theme, reducedMotion, ...sample });
    if (output) await page.screenshot({ path: resolve(output, `${width}-${height}-${theme}.png`) });
  }
  console.log(JSON.stringify({ report, errors }));
  assert.deepEqual(errors, []);
  for (const result of report) {
    assert.equal(result.positions.length, 1, `背景在 ${result.width}×${result.height} 上发生移动`);
    assert.equal(result.heights.length, 1);
    assert.equal(result.paused, false);
    assert.equal(result.rate, 1);
    assert.ok(result.frames > 24, '视频实际解码播放，不以空白视频占位通过');
    assert.equal(result.viewportOverflow, false);
  }
  assert.ok(
    report.find((result) => result.height === 240).scrolls.some((value) => value > 0),
    '窄窗口正文仍然可以滚动',
  );
} finally {
  await browser?.close();
  await server.close();
}
