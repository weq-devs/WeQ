import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-group-join-time'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-card-refactor.stub.ts'),
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
const output = process.env.WEQ_GROUP_CARD_ARTIFACTS;
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
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-card-refactor.html`,
  );
  await page.waitForFunction(() => window.groupCardFirstPaint);
  assert.equal((await page.evaluate(() => window.groupCardFirstPaint)).name, '原来的群名称');
  if (output) await mkdir(output, { recursive: true });
  for (const mode of ['card', 'full']) {
    if (mode === 'full') {
      await page.evaluate(() => window.groupCardQa.full());
      await page.locator('.weq-group-page').waitFor();
    }
    for (const width of [1180, 390, 320])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((theme) => {
          window.groupCardQa.theme.getState().setPreference(theme);
          window.groupCardQa.theme.getState().setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        }, theme);
        await page.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme,
        );
        await page.getByText('我的入群时间', { exact: true }).first().waitFor();
        const label = page.getByText('2024-01-01 00:00:07', { exact: true }).first();
        await label.waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        const date = await label.boundingBox();
        assert.ok(date && date.x >= 0 && date.x + date.width <= width + 1);
        if (output)
          await page.screenshot({ path: resolve(output, `joined-${mode}-${width}-${theme}.png`) });
      }
  }
  await page.evaluate(() => window.groupCardQa.switch());
  await page
    .getByText('2024-01-01 00:00:07', { exact: true })
    .first()
    .waitFor({ state: 'detached' });
  assert.equal(
    (await page.evaluate(() => window.groupCardCalls)).includes('account.listGroupMembers'),
    false,
  );
  assert.deepEqual(errors, []);
  const result = {
    checks: [
      'identity-first',
      'card-and-full-self-join-time',
      'beijing-seconds',
      '12-theme-size-captures',
      'date-within-viewport',
      'no-cross-group-value',
      'no-member-list-query',
    ],
    errors,
  };
  if (output)
    await writeFile(resolve(output, 'joined-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await server.close();
}
