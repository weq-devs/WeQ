import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'intent-progress-'));
const output = process.env.WEQ_INTENT_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  optimizeDeps: { entries: ['test/browser/intent-loading.html'] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'intent-loading.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [resolve(root, '../..')] } },
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
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/intent-loading.html`,
  );
  await page.waitForSelector('.weq-int-profile-skeleton');
  await page.evaluate(() => {
    window.intentQa.setMode('ready');
    const pane = document.querySelector('.chat-pane');
    // 保持真实网格、绘制顺序和主题样式，只用合成资料栏替代联网内容。
    const panel = document.createElement('aside');
    panel.className = 'group-info-panel';
    panel.textContent = '合成群资料';
    pane.append(panel);
    document.querySelector('.intent-qa').style.gridTemplateColumns = 'minmax(0, 1fr)';
    document.querySelector('.weq-int-dialog').style.display = 'none';
  });
  await page.waitForSelector('.weq-intent-chips');
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [1280, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      for (const state of ['expanded', 'collapsed', 'direct']) {
        for (const running of [true, false]) {
          await page.evaluate(
            ({ theme, state, running }) => {
              document.documentElement.dataset.theme = theme;
              document.documentElement.style.setProperty(
                '--weq-accent-effective',
                theme === 'light' ? '#075c30' : '#fff3a1',
              );
              const pane = document.querySelector('.chat-pane');
              pane.classList.toggle('with-group-info', state !== 'direct');
              pane.classList.toggle('group-info-collapsed', state === 'collapsed');
              pane.querySelector('.group-info-panel').style.display =
                state === 'expanded' ? '' : 'none';
              window.intentQa.publishProgress({
                total: 18,
                completed: running ? 12 : 18,
                failed: 3,
                pendingIds: running ? ['pending'] : [],
              });
            },
            { theme, state, running },
          );
          await page.waitForFunction(
            (running) =>
              document.querySelector('.weq-int-batch')?.getAttribute('aria-busy') ===
              String(running),
            running,
          );
          assert.equal(await page.getByLabel('重试分析', { exact: true }).count(), running ? 0 : 1);
          const geometry = await page.locator('.weq-int-batch').evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const message = document.querySelector('.message-scroll').getBoundingClientRect();
            const label = node.querySelector('span');
            const visibleAt = (x, y) => node.contains(document.elementFromPoint(x, y));
            const button = node.querySelector('button');
            const buttonRect = button?.getBoundingClientRect();
            return {
              withinMessages:
                rect.left >= message.left && rect.right <= message.right && rect.top >= message.top,
              topInset: rect.top - message.top,
              endInset: message.right - rect.right,
              labelFits: label.scrollWidth <= label.clientWidth,
              unobscured: [rect.left + 2, rect.right - 2].every((x) =>
                visibleAt(x, rect.top + rect.height / 2),
              ),
              retryReachable:
                !buttonRect ||
                visibleAt(
                  buttonRect.left + buttonRect.width / 2,
                  buttonRect.top + buttonRect.height / 2,
                ),
            };
          });
          assert.deepEqual(
            geometry,
            {
              withinMessages: true,
              topInset: 6,
              endInset: 12,
              labelFits: true,
              unobscured: true,
              retryReachable: true,
            },
            `${width}px ${theme} ${state} running=${running}`,
          );
          if (output && state === 'expanded' && !running) {
            await page.screenshot({ path: resolve(output, `progress-${width}-${theme}.png`) });
          }
          cases += 1;
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`意图感知进度定位与遮挡回归通过：${cases} 个场景`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
