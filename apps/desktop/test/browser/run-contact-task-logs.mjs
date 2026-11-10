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
  cacheDir: resolve(root, 'node_modules/.vite-contact-task-logs'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/contact-task-logs.stub.ts'),
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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-task-logs.html`,
  );
  await page.locator('.weq-exp-detail-stage:last-child .weq-exp-log-line').first().waitFor();
  assert.equal(await page.locator('.weq-exp-detail-stage:last-child [role="log"]').count(), 1);
  assert.equal(await page.locator('details').count(), 0);
  assert.equal(await page.locator('.weq-exp-detail-stage').count(), 2);
  assert.equal(await page.locator('.weq-exp-detail-stage [role="log"]:visible').count(), 2);
  assert.equal(await page.locator('.weq-contact-task-log').count(), 0);
  assert.deepEqual(
    await page
      .locator('.weq-exp-detail-stage-toggle')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-expanded'))),
    ['true', 'true'],
  );
  assert.deepEqual(await page.locator('.weq-exp-detail-stage-pct').allTextContents(), [
    '50%',
    '1%',
  ]);
  await page.evaluate(() => {
    const log = document.querySelector('.weq-exp-detail-stage:last-child [role="log"]');
    window.taskLogQa.log = log;
    window.taskLogQa.blankFrames = 0;
    window.taskLogQa.observer = new MutationObserver(() => {
      if (!log.querySelector('.weq-exp-log-line')) window.taskLogQa.blankFrames++;
    });
    window.taskLogQa.observer.observe(log, { childList: true, subtree: true });
  });
  const append = async () => {
    const count = await page.locator('.weq-exp-detail-stage:last-child .weq-exp-log-line').count();
    await page.getByRole('button', { name: '模拟日志更新' }).click();
    assert.equal(
      await page.locator('.weq-exp-detail-stage:last-child .weq-exp-log-line').count(),
      count,
    );
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll('.weq-exp-detail-stage:last-child .weq-exp-log-line').length >
        count,
      count,
    );
  };
  await append();
  assert.ok(
    await page
      .locator('.weq-exp-detail-stage:last-child [role="log"]')
      .evaluate((log) => log.scrollHeight - log.scrollTop - log.clientHeight <= 1),
  );
  await page.locator('.weq-exp-detail-stage:last-child [role="log"]').evaluate((log) => {
    log.scrollTop = 30;
    log.dispatchEvent(new Event('scroll'));
  });
  await append();
  assert.equal(
    await page
      .locator('.weq-exp-detail-stage:last-child [role="log"]')
      .evaluate((log) => log.scrollTop),
    30,
  );
  await page.locator('.weq-exp-detail-stage:last-child [role="log"]').evaluate((log) => {
    log.scrollTop = log.scrollHeight;
    log.dispatchEvent(new Event('scroll'));
  });
  await append();
  assert.ok(
    await page
      .locator('.weq-exp-detail-stage:last-child [role="log"]')
      .evaluate((log) => log.scrollHeight - log.scrollTop - log.clientHeight <= 1),
  );
  assert.equal(await page.evaluate(() => window.taskLogQa.blankFrames), 0);
  assert.equal(
    await page.evaluate(
      () =>
        window.taskLogQa.log ===
        document.querySelector('.weq-exp-detail-stage:last-child [role="log"]'),
    ),
    true,
  );
  const output = process.env.WEQ_TASK_LOG_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1000, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 700 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate((theme) => {
        const state = window.taskLogQa.theme.getState();
        state.setPreference(theme);
        state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        state.setBackground(theme === 'light' ? 'plain' : 'grid');
      }, theme);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      for (const log of await page.locator('.weq-exp-detail-stage [role="log"]').all()) {
        assert.equal(await log.evaluate((element) => getComputedStyle(element).height), '180px');
        assert.equal(
          await log.evaluate((element) => getComputedStyle(element).backgroundColor),
          'rgb(13, 20, 32)',
        );
      }
      assert.equal(
        await page
          .locator('.weq-exp-detail-stage:last-child [role="log"]')
          .evaluate((log) => getComputedStyle(log).transitionDuration),
        '0s',
      );
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
    }
  assert.deepEqual(errors, []);
  console.log(
    '双日志默认展开、延迟刷新无清空/重挂、独立滚动、320/1000px 深浅主题和减少动态效果验证通过',
  );
} finally {
  await browser?.close();
  await server.close();
}
