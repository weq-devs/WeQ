import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const output = process.env.WEQ_ENTRY_ARTIFACTS;
const unreadOnly = process.argv.includes('--unread');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'conversation-entry-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  optimizeDeps: { entries: ['test/browser/timeline.html'] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'conversation-entry.stub.ts') },
      {
        find: /^@weq\/agentlab$/,
        replacement: resolve(root, '../../packages/agentlab/src/model_selection.ts'),
      },
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const results = [];
  const waitForViewport = (seq, visible) =>
    page.waitForFunction(
      ({ seq, visible }) => {
        const scroll = document.querySelector('.message-scroll');
        if (!scroll) return false;
        const row = scroll.querySelector(`[data-message-id="row-${seq}"]`);
        const bounds = scroll.getBoundingClientRect();
        const rect = row?.getBoundingClientRect();
        return Boolean(rect && rect.top < bounds.bottom && rect.bottom > bounds.top) === visible;
      },
      { seq, visible },
    );
  const assertDismissed = async (dock) => {
    // 等滚动和视口观察回调交付，避免在提示重新出现前就完成断言。
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(await dock.count(), 0, '已看过的未读提醒不应因翻阅历史而重现');
  };
  for (const count of [25, 50]) {
    const seq = 1008;
    const newest = 1000 + count;
    const base = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?entry&count=${count}`;
    await page.goto(`${base}&unread-from=${seq}`);
    const dock = page.getByText(`新的 ${1001 + count - seq} 条未读消息`, { exact: true });
    await dock.waitFor();
    await page.evaluate((id) => window.timelineTest.jump(id), `row-${seq}`);
    await waitForViewport(seq, true);
    await dock.waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      const scroll = document.querySelector('.message-scroll');
      scroll.scrollTop = scroll.scrollHeight;
    });
    await waitForViewport(newest, true);
    await waitForViewport(seq, false);
    await assertDismissed(dock);

    await page.goto(`${base}&unread-from=${newest}`);
    const entryDock = page.getByText('新的 1 条未读消息', { exact: true });
    await waitForViewport(newest, true);
    await entryDock.waitFor({ state: 'hidden' });
    await page.evaluate((id) => window.timelineTest.jump(id), `row-${seq}`);
    await waitForViewport(newest, false);
    await assertDismissed(entryDock);

    const important = newest - 10;
    await page.goto(`${base}&unread-from=${seq}&important-seqs=${important},${newest}`);
    const mentionDock = page.getByTitle('下一条：有人@我', { exact: true });
    const replyDock = page.getByTitle('下一条：有人回复我', { exact: true });
    await waitForViewport(newest, true);
    await waitForViewport(important, false);
    await mentionDock.waitFor();
    assert.equal(await page.locator('.unread-dock-count').textContent(), '1');
    await page.evaluate((id) => window.timelineTest.jump(id), `row-${important}`);
    await waitForViewport(important, true);
    await dock.waitFor();
    await page.evaluate((id) => window.timelineTest.jump(id), `row-${seq}`);
    await waitForViewport(seq, true);
    await assertDismissed(mentionDock);
    await assertDismissed(replyDock);
  }
  if (output) await mkdir(output, { recursive: true });
  const snapshot = () =>
    page.evaluate(() => {
      const scroll = document.querySelector('.message-scroll');
      const last = scroll.querySelector('[role="listitem"]:last-child');
      const bounds = scroll.getBoundingClientRect();
      const rect = last?.getBoundingClientRect();
      const chips = last?.querySelector('.weq-intent-chips')?.getBoundingClientRect();
      return {
        distance: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
        lastVisible: Boolean(rect && rect.top >= bounds.top && rect.bottom <= bounds.bottom + 2),
        intentVisible: Boolean(
          chips && chips.top >= bounds.top && chips.bottom <= bounds.bottom + 2,
        ),
      };
    });
  for (const count of unreadOnly ? [] : [25, 50, 300]) {
    for (const [width, theme, delayed, follow] of [
      [1280, 'light', false, true],
      [1280, 'dark', true, false],
      [390, 'light', false, false],
      [390, 'dark', true, true],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?entry&count=${count}${delayed ? '&delayed' : ''}${follow ? '' : '&no-follow'}`,
      );
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.waitForSelector('.message-line');
      await page.waitForSelector('.weq-intent-chips .weq-intent-pill:not(.is-loading)');
      await page.waitForTimeout(500);
      const state = await snapshot();
      await page.evaluate(() => window.timelineTest.growTail());
      await page.waitForTimeout(500);
      const afterGrowth = await snapshot();
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(250);
      const afterResize = await snapshot();
      if (output && count === 50)
        await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      await page.locator('.message-scroll').hover();
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(250);
      const beforeHistoryGrowth = await page.evaluate(() => window.timelineTest.capture());
      await page.evaluate(() => window.timelineTest.growTail());
      await page.waitForTimeout(250);
      const afterHistoryGrowth = await page.evaluate(() => window.timelineTest.capture());
      const historyPreserved =
        beforeHistoryGrowth.anchorId === afterHistoryGrowth.anchorId &&
        Math.abs(beforeHistoryGrowth.offset - afterHistoryGrowth.offset) < 3;
      await page.evaluate(() => window.timelineTest.reenter());
      await page.waitForTimeout(500);
      const afterReentry = await snapshot();
      await page.evaluate(() => window.timelineTest.beginEntry());
      await page.waitForTimeout(100);
      await page.evaluate((count) => window.timelineTest.entryStage(count), count);
      await page.waitForTimeout(500);
      const duringLoading = await snapshot();
      await page.evaluate(() => window.timelineTest.growTail());
      await page.waitForTimeout(250);
      const duringLoadingGrowth = await snapshot();
      await page.evaluate((count) => window.timelineTest.entryStage(count + 10, true), count);
      await page.waitForTimeout(500);
      const afterLoading = await snapshot();
      await page.evaluate(() => window.timelineTest.beginEntry());
      await page.waitForTimeout(100);
      await page.evaluate((count) => window.timelineTest.entryStage(count), count);
      await page.waitForTimeout(500);
      await page.locator('.message-scroll').hover();
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(250);
      const loadingAnchor = await page.evaluate(() => window.timelineTest.capture());
      await page.evaluate((count) => window.timelineTest.entryStage(count + 10, true), count);
      await page.waitForTimeout(500);
      const settledAnchor = await page.evaluate(() => window.timelineTest.capture());
      const loadingHistoryPreserved =
        loadingAnchor.anchorId === settledAnchor.anchorId &&
        Math.abs(loadingAnchor.offset - settledAnchor.offset) < 3;
      results.push({
        count,
        width,
        theme,
        delayed,
        follow,
        ...state,
        afterGrowth,
        afterResize,
        historyPreserved,
        afterReentry,
        duringLoading,
        duringLoadingGrowth,
        afterLoading,
        loadingHistoryPreserved,
      });
    }
  }
  console.log(JSON.stringify({ unreadViewports: [25, 50], results, errors }, null, 2));
  if (output)
    await writeFile(
      resolve(output, 'entry-report.json'),
      JSON.stringify({ results, errors }, null, 2),
    );
  if (
    errors.length ||
    results.some(
      (result) =>
        result.distance > 2 ||
        !result.lastVisible ||
        !result.intentVisible ||
        result.afterGrowth.distance > 2 ||
        !result.afterGrowth.lastVisible ||
        result.afterResize.distance > 2 ||
        !result.afterResize.lastVisible ||
        result.afterReentry.distance > 2 ||
        !result.afterReentry.lastVisible ||
        !result.afterReentry.intentVisible ||
        result.duringLoading.distance > 2 ||
        !result.duringLoading.lastVisible ||
        result.duringLoadingGrowth.distance > 2 ||
        !result.duringLoadingGrowth.lastVisible ||
        result.afterLoading.distance > 2 ||
        !result.afterLoading.lastVisible ||
        !result.loadingHistoryPreserved ||
        !result.historyPreserved,
    )
  )
    throw new Error('进入会话未定位最新消息');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
