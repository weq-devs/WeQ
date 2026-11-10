import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// 夹具故意挂起字体，截图不能额外等待 document.fonts.ready。
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_DECORATION_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-decoration-readiness'),
  plugins: [react(), tailwind()],
  optimizeDeps: {
    entries: ['test/browser/decoration-readiness.html'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime', 'lucide-react', 'zustand'],
  },
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/decoration-readiness.stub.ts'),
      },
      {
        find: /^.*\/components\/QqMessageContent$/,
        replacement: resolve(root, 'test/browser/decoration-readiness.stub.ts'),
      },
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
const bubble = await sharp({
  create: { width: 40, height: 40, channels: 4, background: '#c5e8ca' },
})
  .png()
  .toBuffer();
const font = await readFile(resolve(root, '../../resources/assistant/fonts/cover.otf'));
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  if (output) await mkdir(output, { recursive: true });
  for (const width of [390, 1200])
    for (const theme of ['light', 'dark']) {
      for (const scenario of [
        'font-first',
        'bubble-first',
        'font-failure',
        'bubble-failure',
        'uncached-stalled-decode',
        'cached-stalled-decode',
      ]) {
        const context = await browser.newContext({
          viewport: { width, height: 700 },
          colorScheme: theme,
        });
        const page = await context.newPage();
        const errors = [];
        const cached = scenario === 'cached-stalled-decode';
        const benchmark = scenario.endsWith('stalled-decode');
        if (benchmark)
          await page.addInitScript(() => {
            HTMLImageElement.prototype.decode = () => new Promise(() => {});
          });
        page.on('pageerror', (error) => errors.push(error.message));
        let releaseFont, releaseBubble;
        const fontGate = new Promise((resolve) => {
          releaseFont = resolve;
        });
        const bubbleGate = new Promise((resolve) => {
          releaseBubble = resolve;
        });
        await page.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === '/fixtures/bubble-skin') {
            await bubbleGate;
            return route.fulfill({
              json:
                scenario === 'bubble-failure'
                  ? null
                  : {
                      itemId: 21009,
                      slice: { left: 4, right: 4, top: 4, bottom: 4 },
                      imageSize: { w: 40, h: 40 },
                      textColor: '#516196',
                      localFile: 'fixture.png',
                    },
            });
          }
          if (url.pathname === '/_media/dressfont') {
            await fontGate;
            return route.fulfill({
              status: scenario === 'font-failure' ? 404 : 200,
              contentType: 'font/otf',
              body: scenario === 'font-failure' ? Buffer.from('invalid-font') : font,
            });
          }
          if (url.pathname === '/_media/dressbubble') {
            assert.equal(cached, false, '已缓存的静态底图不再额外请求');
            if (route.request().headers().range)
              return route.fulfill({ contentType: 'image/png', body: bubble.subarray(0, 24) });
            await bubbleGate;
            return route.fulfill({
              status: scenario === 'bubble-failure' ? 404 : 200,
              contentType: 'image/png',
              body: scenario === 'bubble-failure' ? Buffer.from('invalid-image') : bubble,
            });
          }
          return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
        });
        try {
          await page.goto(
            `http://127.0.0.1:${server.httpServer.address().port}/test/browser/decoration-readiness.html?theme=${theme}${benchmark ? '&rows=48' : ''}${cached ? `&inline=${encodeURIComponent(`data:image/png;base64,${bubble.toString('base64')}`)}` : ''}`,
            { waitUntil: 'domcontentloaded' },
          );
          await page.locator('.message-content').first().waitFor({ state: 'attached' });
          if (benchmark) {
            const commits = await page.evaluate(() => window.bubbleCommits);
            assert.ok(commits.length >= 48);
            assert.ok(
              commits.every(
                (commit) =>
                  commit.bubbleId === (cached ? 21009 : 0) && commit.visible === 'visible',
              ),
            );
            assert.equal(await page.locator('[data-bubble-pending]').count(), 0);
            if (cached) {
              const png = await page.locator('.message-content').first().screenshot();
              const { data } = await sharp(png)
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
              let green = 0;
              for (let i = 0; i < data.length; i += 4)
                if (data[i] === 197 && data[i + 1] === 232 && data[i + 2] === 202) green++;
              assert.ok(green > 20, '正文首屏必须实际绘制缓存底图');
              if (output)
                await page.screenshot({ path: resolve(output, `${width}-${theme}-cached.png`) });
            }
            console.log(
              JSON.stringify({
                width,
                theme,
                scenario,
                firstCommitMs: commits[0].atMs,
                rows: 48,
                passed: true,
              }),
            );
            continue;
          }
          const checkDefault = async () => {
            assert.equal(await page.locator('[data-bubble], [data-font]').count(), 0);
            const contrast = await page.locator('.message-content').evaluateAll((nodes) => {
              const canvas = document.createElement('canvas');
              canvas.width = canvas.height = 1;
              const context = canvas.getContext('2d', { willReadFrequently: true });
              const luminance = (color) => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                const channels = Array.from(context.getImageData(0, 0, 1, 1).data)
                  .slice(0, 3)
                  .map((v) => {
                    const n = v / 255;
                    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
                  });
                return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
              };
              return nodes.map((node) => {
                const style = getComputedStyle(node);
                let surface = node;
                while (
                  surface.parentElement &&
                  getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)'
                )
                  surface = surface.parentElement;
                const foreground = luminance(style.color),
                  background = luminance(getComputedStyle(surface).backgroundColor);
                return (
                  (Math.max(foreground, background) + 0.05) /
                  (Math.min(foreground, background) + 0.05)
                );
              });
            });
            assert.ok(
              contrast.every((ratio) => ratio >= 4.5),
              JSON.stringify({ width, theme, scenario, contrast }),
            );
          };
          await checkDefault();
          if (scenario === 'font-first') releaseFont();
          else releaseBubble();
          await page.waitForTimeout(150);
          if (scenario === 'font-first') await checkDefault();
          else if (scenario === 'bubble-failure') await checkDefault();
          else {
            assert.equal(await page.locator('[data-bubble="21009"]').count(), 2);
            assert.equal(await page.locator('[data-font]').count(), 0);
            assert.equal(await page.locator('[data-bubble-pending]').count(), 0);
          }
          if (output && scenario === 'font-first')
            await page.screenshot({ path: resolve(output, `${width}-${theme}-loading.png`) });
          releaseFont();
          releaseBubble();
          if (scenario === 'bubble-failure') {
            await page.waitForTimeout(150);
            await checkDefault();
          } else if (scenario === 'font-failure') {
            await page.waitForTimeout(150);
            assert.equal(await page.locator('[data-bubble="21009"]').count(), 2);
            assert.equal(await page.locator('[data-font]').count(), 0);
          } else {
            await page.waitForFunction(
              () =>
                document.querySelectorAll('[data-bubble="21009"][data-font="31009"]').length === 2,
            );
            assert.equal(
              await page.evaluate(() => document.fonts.check('16px weq-message-dress-31009-1')),
              true,
            );
            if (output && scenario === 'font-first')
              await page.screenshot({ path: resolve(output, `${width}-${theme}-ready.png`) });
          }
          assert.deepEqual(errors, []);
          console.log(JSON.stringify({ width, theme, scenario, passed: true }));
        } finally {
          releaseFont();
          releaseBubble();
          await context.close();
        }
      }
    }
} finally {
  await browser?.close();
  await server.close();
}
