import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const output = process.env.WEQ_TOGGLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-settings-toggle'),
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
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/component-appearance.html`,
  );
  const parent = page.getByRole('checkbox', { name: '全部提醒示例', exact: true });
  await parent.waitFor();
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [390, 1180]) {
    await page.setViewportSize({ width, height: 920 });
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      for (const style of ['classic', 'retro', 'qqnt']) {
        for (const accent of ['#075c30', '#ffffff', '#000000']) {
          const label = `${width}-${theme}-${style}-${accent}`;
          await page.evaluate(
            ({ theme, style, accent }) => {
              const store = window.appearanceQa.store.getState();
              store.setPreference(theme);
              store.setComponentStyle(style);
              store.setAccent(accent);
              store.setBackground(theme === 'light' ? 'grid' : 'telegram');
            },
            { theme, style, accent },
          );
          await page.getByRole('button', { name: '重置开关示例' }).click();
          assert.equal(await parent.getAttribute('aria-checked'), 'mixed', label);
          const metrics = await parent.evaluate((node) => {
            const track = node.querySelector('.weq-set-toggle-track');
            const knob = node.querySelector('.weq-set-toggle-knob');
            const box = track.getBoundingClientRect();
            const thumb = knob.getBoundingClientRect();
            return {
              width: box.width,
              height: box.height,
              centerX: thumb.x + thumb.width / 2 - (box.x + box.width / 2),
              centerY: thumb.y + thumb.height / 2 - (box.y + box.height / 2),
              reducedMotion: getComputedStyle(knob).transitionDuration,
              marker: Boolean(knob.querySelector('.lucide-minus')),
              overflow: node.scrollWidth > node.clientWidth + 1,
            };
          });
          assert.equal(metrics.width, 40, label);
          assert.equal(metrics.height, 22, label);
          assert.ok(Math.abs(metrics.centerX) < 0.6 && Math.abs(metrics.centerY) < 0.6, label);
          assert.equal(metrics.reducedMotion, '0s', label);
          assert.equal(metrics.marker, false, label);
          assert.equal(metrics.overflow, false, label);
          const disabled = page.getByRole('checkbox', { name: '禁用的部分开启', exact: true });
          assert.equal(await disabled.isDisabled(), true, label);
          assert.equal(await disabled.getAttribute('aria-checked'), 'mixed', label);
          await parent.focus();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Shift+Tab');
          assert.notEqual(
            await parent.evaluate((node) => getComputedStyle(node).outlineStyle),
            'none',
            label,
          );
          if (output && style === 'qqnt' && accent === '#075c30')
            await page.locator('[data-mixed-toggle-fixture]').screenshot({
              path: resolve(output, `${width}-${theme}.png`),
            });
          await parent.press('Enter');
          assert.equal(await parent.getAttribute('aria-checked'), 'true', label);
          await parent.press('Space');
          assert.equal(await parent.getAttribute('aria-checked'), 'false', label);
          await parent.click();
          assert.equal(await parent.getAttribute('aria-checked'), 'true', label);
          await page.getByRole('switch', { name: '提醒子项 1', exact: true }).click();
          assert.equal(await parent.getAttribute('aria-checked'), 'mixed', label);
          assert.equal(await parent.getAttribute('role'), 'checkbox', label);
          cases++;
        }
      }
    }
  }
  await page.emulateMedia({ forcedColors: 'active' });
  await page.getByRole('button', { name: '重置开关示例' }).click();
  assert.notEqual(
    await parent.locator('.weq-set-toggle-knob').evaluate((node) => getComputedStyle(node).color),
    await parent
      .locator('.weq-set-toggle-knob')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, keyboard: true, forcedColors: true, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
