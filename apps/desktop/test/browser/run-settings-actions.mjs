import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-settings-actions'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-actions.html`,
  );
  await page.waitForSelector('[data-download]');
  const checks = () =>
    page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.weq-set-btn')];
      const standalone = [
        ...document.querySelectorAll(
          '[data-download], [data-backup] .weq-backup-actions button, [data-save]',
        ),
      ];
      return {
        contentWidth: standalone.every(
          (node) =>
            node.getBoundingClientRect().width <
            node.parentElement.getBoundingClientRect().width * 0.8,
        ),
        centered: buttons.every((node) => getComputedStyle(node).justifyContent === 'center'),
        bounded: buttons.every((node) => {
          const box = node.getBoundingClientRect();
          const parent = node.parentElement.getBoundingClientRect();
          return (
            box.width > 0 &&
            box.height >= 28 &&
            box.left >= parent.left &&
            box.right <= parent.right + 1
          );
        }),
        icons: buttons.every(
          (node) => node.querySelector('svg').getBoundingClientRect().width === 14,
        ),
        neutral: ['[data-download]'].every((selector) => {
          const node = document.querySelector(selector);
          const color = getComputedStyle(node).backgroundColor;
          return (
            color !== getComputedStyle(document.querySelector('[data-save]')).backgroundColor ||
            color === 'rgba(0, 0, 0, 0)'
          );
        }),
        noOverflow: document.documentElement.scrollWidth <= innerWidth,
      };
    });
  // 旧版网格拉伸必须能被本测试捕获，避免夹具自身掩盖问题。
  const oldLayout = await page.addStyleTag({
    content:
      '.weq-set .weq-set-btn{width:auto;justify-self:stretch;align-self:stretch;justify-content:normal}',
  });
  if ((await checks()).contentWidth) throw new Error('未能复现旧版按钮拉伸');
  await oldLayout.evaluate((node) => node.remove());
  const failures = [];
  let cases = 0;
  const output = process.env.WEQ_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark', 'system']) {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      for (const style of ['qqnt', 'classic', 'minimal', 'retro']) {
        for (const density of ['compact', 'comfortable']) {
          await page.evaluate(
            ({ theme, style, density, width }) => {
              const store = window.settingsActionsQa.getState();
              store.setPreference(theme);
              store.setComponentStyle(style);
              store.setDensity(density);
              store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
              store.setBackground(width === 1280 ? 'grid' : 'telegram');
            },
            { theme, style, density, width },
          );
          await page.waitForTimeout(20);
          for (const [name, passed] of Object.entries(await checks()))
            if (!passed) failures.push(`${width}/${theme}/${style}/${density}: ${name}`);
          cases++;
        }
        if (output && style === 'qqnt')
          await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), fullPage: true });
      }
    }
  }
  await page.locator('[data-download]').focus();
  const focused = await page
    .locator('[data-download]')
    .evaluate((node) => getComputedStyle(node).outlineStyle);
  if (focused === 'none') failures.push('键盘焦点不可见');
  console.log(JSON.stringify({ cases, failures, errors }, null, 2));
  if (failures.length || errors.length) throw new Error([...failures, ...errors].join('\n'));
} finally {
  await browser?.close();
  await server.close();
}
