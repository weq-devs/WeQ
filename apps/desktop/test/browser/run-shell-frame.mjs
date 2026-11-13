import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.cache/shell-frame-vite'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/shell-frame.stub.ts'),
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
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_SHELL_FRAME_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/shell-frame.html`,
  );
  await page.waitForSelector('.app-rail .weq-rail-button');
  const report = [];
  for (const [width, height] of [
    [1280, 900],
    [1000, 720],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => window.shellQa.theme.getState().setPreference(theme), theme);
      await page.waitForTimeout(60);
      const metrics = await page.evaluate(() => {
        const box = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            radius: style.borderRadius,
            font: style.fontSize,
          };
        };
        const buttons = [...document.querySelectorAll('.app-rail .weq-rail-button')]
          .map((button) => {
            const rect = button.getBoundingClientRect();
            if (!rect.width || getComputedStyle(button).display === 'none') return null;
            const svg = button.querySelector('svg');
            const svgRect = svg?.getBoundingClientRect();
            return {
              title: button.getAttribute('title'),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
              icon: svgRect ? `${Math.round(svgRect.width)}x${Math.round(svgRect.height)}` : null,
              stroke: svg ? getComputedStyle(svg).strokeWidth : null,
              lucide: Boolean(svg?.classList.contains('lucide')),
              radius: getComputedStyle(button).borderRadius,
            };
          })
          .filter(Boolean);
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          bar: box('.app-title-bar'),
          logo: box('.app-title-bar-logo-wrap'),
          search: box('.weq-titlebar-search'),
          searchInput: box('.weq-titlebar-search input'),
          restriction: box('.weq-titlebar-restriction'),
          rail: box('.app-rail'),
          buttons,
          greet: box('.weq-chathome-greet'),
        };
      });
      report.push({ width, theme, ...metrics });
      if (output)
        await page.screenshot({
          path: resolve(output, `${width}-${height}-${theme}.png`),
        });
    }
  }
  const sizes = new Set(report[0].buttons.map((button) => `${button.w}x${button.h}`));
  assert.equal(sizes.size, 1, '左侧 rail 入口尺寸必须一致');
  const railIcons = new Set(report[0].buttons.map((button) => button.icon));
  assert.equal(railIcons.size, 1, '左侧 rail 图标尺寸必须一致');
  // 品牌图标（QQ 空间）是实心路径，stroke-width 对它没有意义；线框图标必须同一线宽。
  const strokes = new Set(
    report[0].buttons
      .filter((button) => button.stroke !== null && button.lucide)
      .map((button) => button.stroke),
  );
  assert.equal(strokes.size, 1, '左侧 rail 线框图标线宽必须一致');
  for (const row of report) assert.equal(row.overflow, false, `${row.width} 不能横向溢出`);
  console.log(JSON.stringify({ report, errors }, null, 1));
} finally {
  await browser?.close();
  await server.close();
}
