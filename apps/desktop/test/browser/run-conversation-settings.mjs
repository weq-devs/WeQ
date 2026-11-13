import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-conversation-settings'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/conversation-settings.stub.ts'),
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/conversation-settings.html`,
  );
  await page.getByText('QQ 在线', { exact: true }).waitFor();
  const pane = page.locator('.weq-conversation-settings-pane');
  await page.getByRole('switch', { name: '消息免打扰', exact: true }).waitFor();
  assert.equal(await pane.getByText('好友备注', { exact: true }).count(), 0);
  assert.equal(await pane.getByText('好友分组', { exact: true }).count(), 0);
  assert.equal(await pane.locator('.weq-set-card').count(), 2);
  await page.getByRole('switch', { name: '置顶会话', exact: true }).click();
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="置顶会话"]')?.getAttribute('aria-checked') === 'true',
      undefined,
      { timeout: 5000 },
    );
  } catch (error) {
    console.log(
      await page.evaluate(() => ({
        calls: window.settingsCalls,
        text: document.body.innerText,
        toggle: document.querySelector('[aria-label="置顶会话"]')?.outerHTML,
      })),
    );
    throw error;
  }
  const output = process.env.WEQ_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1280, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate((theme) => {
        window.settingsTheme.getState().setPreference(theme);
        window.settingsTheme.getState().setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
      }, theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      assert.equal(await pane.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
      const link = page.getByRole('button', { name: '查看联系人资料', exact: true });
      assert.equal(await link.isVisible(), true);
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
    }
  await pane.getByRole('button', { name: '意图感知', exact: true }).click();
  assert.equal(
    await page
      .getByRole('switch', { name: '本会话意图感知跟随应用设置' })
      .getAttribute('aria-checked'),
    'true',
  );
  assert.equal(await pane.getByText('未生效：应用意图感知已关闭', { exact: true }).count(), 1);
  await pane.getByRole('button', { name: '查看联系人资料', exact: true }).click();
  await page.getByLabel('资料导航结果').filter({ hasText: 'u_fixture' }).waitFor();
  assert.equal(await pane.count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      widths: [1280, 390, 320],
      themes: ['light', 'dark'],
      checks: [
        'no-duplicate-fields',
        'space-section',
        'pin-readback',
        'intent-state',
        'profile-navigation',
      ],
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
