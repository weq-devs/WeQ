import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'intent-first-frame-'));
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
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  const errors = [];
  for (const width of [1280, 390, 320]) {
    for (const theme of ['light', 'dark']) {
      for (const reducedMotion of ['reduce', 'no-preference']) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) =>
          new URL(route.request().url()).hostname === '127.0.0.1' ||
          route.request().url().startsWith('data:')
            ? route.continue()
            : route.abort(),
        );
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/intent-loading.html?first-frame=1`,
        );
        await page.waitForSelector('[data-intent-state="preparing"]');
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const initial = await page.evaluate(() => window.intentQa.frames[0]);
        assert.equal(initial.pills, 2, '消息首次提交时已有两个可见占位');
        assert.equal(initial.visible, true);
        const reels = page.locator('.intent-qa .weq-intent-loading-reel');
        assert.equal(await reels.count(), 2, '缓存与批次进度返回前就进入随机图标动画');
        if (reducedMotion === 'no-preference') {
          const before = await reels.first().locator('svg').getAttribute('class');
          await page.waitForFunction(
            (before) =>
              document
                .querySelector('.intent-qa .weq-intent-loading-icon')
                .getAttribute('class') !== before,
            before,
            { timeout: 5000 },
          );
        } else {
          assert.equal(
            await reels.first().evaluate((node) => node.getAnimations({ subtree: true }).length),
            0,
            '减少动态效果时保留静态图标',
          );
        }
        const samples = await page.evaluate(async () => {
          const qa = window.intentQa;
          const samples = [];
          const sample = async () => {
            await new Promise(requestAnimationFrame);
            const bubbles = [...document.querySelectorAll('.intent-qa .message-bubble')];
            samples.push(
              bubbles.map((node) => ({
                id: node.dataset.messageId,
                height: node.getBoundingClientRect().height,
                pills: node.querySelectorAll('.weq-intent-pill').length,
                state: node.querySelector('.weq-intent-chips').dataset.intentState,
              })),
            );
          };
          await sample();
          qa.releaseCache();
          await sample();
          qa.setMessages(['history', 'message']);
          await sample();
          qa.setMessages(['history', 'message', 'fetched-1', 'fetched-2']);
          await sample();
          qa.setMessages(['history', 'roaming:protocol:2:77', 'message', 'fetched-1', 'fetched-2']);
          await sample();
          qa.publishProgress({ total: 1, completed: 0, failed: 0, pendingIds: ['message'] });
          await sample();
          for (let frame = 0; frame < 5; frame++) await sample();
          qa.publishResult();
          await sample();
          return samples;
        });
        assert.ok(samples.flat().every((row) => row.pills === 2 && row.height === initial.height));
        assert.equal(samples[0][0].state, 'preparing');
        assert.equal(samples[1][0].state, 'idle');
        assert.equal(samples.at(-1).find((row) => row.id === 'message').state, 'ready');
        assert.ok(samples.some((rows) => rows.some((row) => row.state === 'pending')));
        const commits = await page.evaluate(() => window.intentQa.frames);
        assert.ok(commits.every((frame) => frame.pills === 2 && frame.visible));
        await page.evaluate(() =>
          window.intentQa.setMessages([
            ...Array.from({ length: 30 }, (_, i) => `history-${i}`),
            'message',
          ]),
        );
        await page.waitForFunction(
          () => document.querySelectorAll('.intent-qa .message-bubble').length === 31,
        );
        const anchorStable = await page.evaluate(async () => {
          const qa = window.intentQa;
          await new Promise(requestAnimationFrame);
          const scroll = document.querySelector('.intent-qa .message-scroll');
          scroll.scrollTop = scroll.scrollHeight;
          const target = document.querySelector('[data-message-id="message"]');
          const before = {
            top: target.getBoundingClientRect().top,
            height: scroll.scrollHeight,
            scroll: scroll.scrollTop,
          };
          qa.publishProgress({ total: 1, completed: 0, failed: 0, pendingIds: ['history-0'] });
          await new Promise(requestAnimationFrame);
          qa.publishResult('history-0');
          await new Promise(requestAnimationFrame);
          return {
            state: document.querySelector('[data-message-id="history-0"] .weq-intent-chips').dataset
              .intentState,
            before,
            after: {
              top: target.getBoundingClientRect().top,
              height: scroll.scrollHeight,
              scroll: scroll.scrollTop,
            },
          };
        });
        assert.equal(anchorStable.state, 'ready');
        assert.deepEqual(anchorStable.after, anchorStable.before, '附属状态更新不移动阅读锚点');
        assert.ok(anchorStable.after.scroll > 0);
        if (output && reducedMotion === 'reduce' && width !== 320)
          await page.screenshot({ path: resolve(output, `first-frame-${width}-${theme}.png`) });
        await page.close();
        cases++;
        const hidden = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion });
        hidden.on('pageerror', (error) => errors.push(error.message));
        await hidden.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/intent-loading.html?first-frame=1&animation-off=1`,
        );
        await hidden.locator('.intent-qa .message-text').waitFor();
        await hidden.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const first = await hidden.evaluate(() => window.intentQa.frames[0]);
        assert.equal(first.pills, 0, '关闭动画时首次提交不挂载胶囊');
        const painted = await hidden.evaluate(async () => {
          const sample = async () => {
            await new Promise(requestAnimationFrame);
            const bubble = document.querySelector('.intent-qa .message-bubble');
            return {
              height: bubble.getBoundingClientRect().height,
              chips: bubble.querySelectorAll('.weq-intent-chips').length,
              textHeight: bubble.querySelector('.message-text').getBoundingClientRect().height,
            };
          };
          const samples = [await sample()];
          window.intentQa.releaseCache();
          samples.push(await sample());
          window.intentQa.publishProgress({
            total: 1,
            completed: 0,
            failed: 0,
            pendingIds: ['message'],
          });
          samples.push(await sample());
          window.intentQa.publishResult();
          const result = await sample();
          return { samples, result };
        });
        assert.ok(
          painted.samples.every((row) => row.chips === 0 && row.height === row.textHeight),
          '等待阶段的真实绘制不占用空间',
        );
        assert.equal(painted.result.chips, 1);
        assert.ok(painted.result.height > first.height);
        if (output && reducedMotion === 'reduce' && width !== 320)
          await hidden.screenshot({ path: resolve(output, `animation-off-${width}-${theme}.png`) });
        await hidden.close();
        cases++;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, output }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
