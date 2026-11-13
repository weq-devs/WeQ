import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_SETTINGS_QA;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-profile-settings'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/profile-identity.stub.ts'),
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
  const errors = [];
  let cases = 0;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const theme of ['light', 'dark']) {
      for (const tool of [false, true]) {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-settings.html${tool ? '?tool' : ''}`,
        );
        await page.getByRole('button', { name: '我的资料', exact: true }).waitFor();
        await page.evaluate((theme) => {
          const store = window.profileSettingsQa.theme.getState();
          store.setPreference(theme);
          store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          store.setBackground('grid');
        }, theme);
        if (tool) await page.locator('[data-source-tool]').click();
        await page.getByRole('button', { name: '我的资料', exact: true }).click();
        await page.getByRole('region', { name: '我的资料', exact: true }).waitFor();
        for (const close of ['button', 'escape']) {
          await page.getByRole('button', { name: '打开设置', exact: true }).click();
          const settings = page.locator('.weq-settings-dialog');
          await settings.waitFor();
          assert.equal(await page.locator('#workspace-base-page').isVisible(), false);
          const hit = await settings.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 30));
          });
          assert.equal(hit, true, `${width}/${theme}: 设置真实绘制在前景`);
          const category = page.locator('.weq-settings-nav-item').first();
          await category.click();
          await page.screenshot({
            path: output ? resolve(output, `${width}-${theme}-${tool}-${close}.png`) : undefined,
            animations: 'disabled',
          });
          if (close === 'button') await page.locator('.weq-settings-close').click();
          else await page.keyboard.press('Escape');
          await settings.waitFor({ state: 'detached' });
          await page.getByRole('region', { name: '我的资料', exact: true }).waitFor();
        }
        await page.getByRole('button', { name: '关闭资料', exact: true }).click();
        if (tool) {
          await page.locator('[data-source-tool]').waitFor();
          assert.equal(await page.locator('[data-source-tool]').textContent(), '1');
        } else await page.locator('[data-original-page]').waitFor();
        cases++;
      }
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
