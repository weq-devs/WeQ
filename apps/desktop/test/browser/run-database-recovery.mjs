import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-database-recovery'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/database-recovery.stub.ts'),
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const output = process.env.WEQ_RECOVERY_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1180])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/database-recovery.html`,
      );
      await page.waitForFunction(() => window.recoveryQa);
      await page.evaluate((theme) => {
        window.recoveryQa.theme.getState().setPreference(theme);
        window.recoveryQa.theme.getState().setAccent(theme === 'light' ? '#006d50' : '#ffe593');
      }, theme);
      assert.equal(await page.getByText('容错级别', { exact: true }).count(), 0);
      assert.equal(await page.getByText('容错记录', { exact: true }).count(), 0);
      const setting = page.locator('section[data-setting-id="database-repair"]');
      assert.equal(await setting.count(), 1);
      const borders = await setting
        .locator('.weq-set-row, .weq-set-card-head, .weq-maintenance-rows')
        .evaluateAll((nodes) =>
          nodes.map((node) => [
            getComputedStyle(node).borderTopWidth,
            getComputedStyle(node).borderBottomWidth,
          ]),
        );
      assert(
        borders.every((pair) => pair.every((width) => width === '0px')),
        JSON.stringify(borders),
      );
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: '跳过此区间并继续' }).click();
      assert.deepEqual(await page.evaluate(() => window.recoveryQa.calls.at(-1)), {
        decision: 'skip',
        remaining: true,
      });
      await page.locator('.weq-database-recovery summary').click();
      for (const kind of ['ranges', 'table', 'read']) {
        await page.evaluate((kind) => {
          window.recoveryQa.setKind(kind);
          window.recoveryQa.setCanSkip(kind !== 'read');
        }, kind);
        await page.waitForFunction(
          (kind) =>
            document.querySelector('.weq-database-recovery h4')?.textContent ===
            {
              ranges: '部分消息暂时无法读取',
              table: '这张表无法继续读取',
              read: '数据库读取未完成',
            }[kind],
          kind,
        );
        const overflowing = await page
          .locator(
            '.weq-database-recovery button, .weq-database-recovery p, .weq-database-recovery label',
          )
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => {
                const r = node.getBoundingClientRect();
                return (
                  r.width > 0 &&
                  (r.left < 0 ||
                    r.right > innerWidth + 1 ||
                    node.scrollWidth > node.clientWidth + 1)
                );
              })
              .map((node) => node.textContent),
          );
        assert.deepEqual(overflowing, []);
        if (output)
          await page.screenshot({
            path: `${output}/${theme}-${width}-${kind}.png`,
            fullPage: true,
          });
        cases++;
      }
      await page.getByRole('button', { name: '尝试修复…' }).focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => window.recoveryQa.calls.at(-1)), {
        decision: 'repair',
        remaining: false,
      });
    }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
