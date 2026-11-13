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
const showBytes = execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=160x320',
  '-frames:v',
  '1',
  '-f',
  'image2pipe',
  '-vcodec',
  'png',
  'pipe:1',
]);
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
        find: /^.*\/hooks\/useContactCard$/,
        replacement: resolve(root, 'test/browser/home-backdrop.stub.ts'),
      },
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
  let showRequests = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/_media/qqshow') {
      showRequests += 1;
      return route.request().headers().referer?.includes('show=broken')
        ? route.fulfill({ status: 404, body: '' })
        : route.fulfill({ contentType: 'image/png', body: showBytes });
    }
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

    for (const mode of ['ready', 'off', 'none', 'broken']) {
      const previousRequests = showRequests;
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/home-backdrop.html?show=${mode}`,
      );
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#47bc97' : '#c64556',
        );
      }, theme);
      if (mode === 'ready') {
        await page.locator('.weq-chathome-qqshow').waitFor({ state: 'visible' });
        const layout = await page.evaluate(() => {
          const image = document.querySelector('.weq-chathome-qqshow');
          const stage = document.querySelector('.weq-chathome-stage');
          const rect = image.getBoundingClientRect();
          const box = stage.getBoundingClientRect();
          const tags = [...document.querySelectorAll('.weq-tag')];
          return {
            loaded: image.complete && image.naturalWidth === 160 && image.naturalHeight === 320,
            fit: getComputedStyle(image).objectFit,
            radius: getComputedStyle(image).borderRadius,
            centered:
              Math.abs(rect.x + rect.width / 2 - box.x - box.width / 2) < 1 &&
              Math.abs(rect.y + rect.height / 2 - box.y - box.height / 2) < 1,
            contained: rect.width <= box.width && rect.height <= box.height,
            tags: tags.length,
            roundTags: tags.every(
              (tag) =>
                getComputedStyle(tag.querySelector('.weq-tag-body')).borderRadius === '50%' &&
                tag.offsetWidth === tag.offsetHeight,
            ),
            avatar: Boolean(stage.querySelector('.weq-orb')),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert.deepEqual(layout, {
          loaded: true,
          fit: 'contain',
          radius: '0px',
          centered: true,
          contained: true,
          tags: 10,
          roundTags: true,
          avatar: false,
          overflow: false,
        });
        if (output) {
          // 等待原标签环展开后取图，不改变动画或力布局以迎合截图。
          await page.waitForTimeout(reducedMotion === 'reduce' ? 100 : 3500);
          await page.screenshot({
            path: resolve(output, `${width}-${height}-${theme}-qqshow.png`),
          });
        }
      } else {
        await page.locator('.weq-orb').waitFor({ state: 'visible' });
        if (mode === 'broken')
          await page.waitForFunction(() => !document.querySelector('.weq-chathome-qqshow'));
        else assert.equal(showRequests, previousRequests, `${mode} 不应加载 QQ 秀`);
        assert.equal(await page.locator('.weq-chathome-qqshow').count(), 0);
      }
    }
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
