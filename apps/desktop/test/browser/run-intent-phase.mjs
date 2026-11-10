import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'intent-phase-'));
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
  const errors = [];
  let cases = 0;
  for (const width of [1280, 390]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
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
      await page.waitForSelector('.weq-intent-loading-reel');
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      // 确保旧动画已进入半轮后再插入消息，防止同批挂载掩盖相位偏差。
      await page.waitForFunction(() => {
        const animation = document.querySelector('.weq-intent-loading-reel').getAnimations()[0];
        const phase = animation.currentTime % animation.effect.getTiming().duration;
        return phase > 700 && phase < 1200;
      });
      await page.evaluate(() => window.intentQa.setMessages(['message', 'later']));
      await page.waitForFunction(
        () => document.querySelectorAll('.weq-intent-loading-reel').length === 4,
      );
      const assertInPhase = async (label) => {
        const state = await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const reels = [...document.querySelectorAll('.weq-intent-loading-reel')];
          const animations = reels.flatMap((node) => node.getAnimations({ subtree: true }));
          return {
            reels: reels.length,
            animations: animations.length,
            starts: animations.map((animation) => animation.startTime),
            times: animations.map((animation) => animation.currentTime),
            transforms: reels.map((node) => getComputedStyle(node).transform),
            opacities: reels.map((node) => getComputedStyle(node).opacity),
          };
        });
        assert.equal(state.reels, 4);
        assert.ok(state.animations >= 8);
        assert.ok(state.starts.every((start) => typeof start === 'number'));
        assert.ok(
          Math.max(...state.starts) - Math.min(...state.starts) < 1,
          `${width}/${theme}/${label}: 动画起点一致 ${JSON.stringify(state)}`,
        );
        assert.ok(Math.max(...state.times) - Math.min(...state.times) < 1);
        assert.equal(new Set(state.transforms).size, 1, '所有图标同时入场、停留和离场');
        assert.equal(new Set(state.opacities).size, 1);
      };
      await assertInPhase('延迟挂载');
      await page.waitForTimeout(5100);
      await assertInPhase('跨轮随机换图后');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(
        await page
          .locator('.weq-intent-loading-reel')
          .first()
          .evaluate((node) => node.getAnimations({ subtree: true }).length),
        0,
      );
      await page.waitForTimeout(350);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await assertInPhase('恢复动态效果');
      await page.evaluate(() => window.intentQa.setMessages(['message']));
      await page.waitForFunction(
        () => document.querySelectorAll('.weq-intent-loading-reel').length === 2,
      );
      await page.waitForTimeout(450);
      await page.evaluate(() => window.intentQa.setMessages(['message', 'reinserted']));
      await page.waitForFunction(
        () => document.querySelectorAll('.weq-intent-loading-reel').length === 4,
      );
      await assertInPhase('重新挂载');
      if (output) await page.screenshot({ path: resolve(output, `phase-${width}-${theme}.png`) });
      await page.close();
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, synchronized: true, output }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
