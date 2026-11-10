import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
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
  create: { width: 40, height: 40, channels: 4, background: '#f6f7fb' },
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
      for (const scenario of ['font-first', 'bubble-first', 'font-failure', 'bubble-failure']) {
        const context = await browser.newContext({
          viewport: { width, height: 700 },
          colorScheme: theme,
        });
        const page = await context.newPage();
        const errors = [];
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
          if (url.pathname === '/_media/dressfont') {
            await fontGate;
            return route.fulfill({
              status: scenario === 'font-failure' ? 404 : 200,
              contentType: 'font/otf',
              body: font,
            });
          }
          if (url.pathname === '/_media/dressbubble') {
            if (route.request().headers().range)
              return route.fulfill({ contentType: 'image/png', body: bubble.subarray(0, 24) });
            await bubbleGate;
            return route.fulfill({
              status: scenario === 'bubble-failure' ? 404 : 200,
              contentType: 'image/png',
              body: bubble,
            });
          }
          return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
        });
        try {
          await page.goto(
            `http://127.0.0.1:${server.httpServer.address().port}/test/browser/decoration-readiness.html?theme=${theme}`,
            { waitUntil: 'domcontentloaded' },
          );
          await page.locator('.message-content').first().waitFor();
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
          await checkDefault();
          if (output && scenario === 'font-first')
            await page.screenshot({ path: resolve(output, `${width}-${theme}-loading.png`) });
          releaseFont();
          releaseBubble();
          if (scenario.endsWith('failure')) {
            await page.waitForTimeout(150);
            await checkDefault();
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
