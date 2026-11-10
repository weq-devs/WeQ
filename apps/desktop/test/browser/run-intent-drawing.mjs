import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheRoot = resolve(root, 'node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const cacheDir = await mkdtemp(resolve(cacheRoot, 'intent-drawing-'));
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
  await page.evaluate(() => window.intentQa.setMode('loading'));
  await page.waitForSelector('.weq-intent-loading-icon');
  const chips = page.locator('.weq-intent-chips');
  const initial = await chips.boundingBox();
  if (output) {
    await mkdir(output, { recursive: true });
    await page.waitForTimeout(1700);
    await chips.screenshot({ path: resolve(output, 'live.png') });
  }
  await chips.evaluate((node) => {
    for (const animation of node.getAnimations({ subtree: true })) animation.pause();
  });
  // 手动逐轮检查随机序列时延长轮长，避免全局相位恰逢真实轮末而额外换图。
  const sequenceTiming = await page.addStyleTag({
    content:
      '.weq-intent-loading-reel, .weq-intent-loading-icon > * { animation-duration: 86400000ms !important; }',
  });
  for (const [kind, count] of [
    ['intent', 17],
    ['emotion', 15],
  ]) {
    const sequence = [];
    const reel = chips.locator(`[data-loading-kind="${kind}"] .weq-intent-loading-reel`);
    for (let index = 0; index < count; index++) {
      sequence.push(await reel.locator('svg').getAttribute('class'));
      await reel.evaluate(async (node) => {
        node.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }));
        await new Promise(requestAnimationFrame);
      });
    }
    assert.equal(new Set(sequence).size, count, `${kind}: 分别完整覆盖自己的图标列表`);
    assert.notEqual(
      await reel.locator('svg').getAttribute('class'),
      sequence.at(-1),
      '跨轮不连续重复',
    );
  }
  await sequenceTiming.evaluate((style) => {
    for (const animation of document
      .querySelector('.weq-intent-chips')
      .getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 1000;
    }
    style.remove();
  });
  const states = await chips.evaluate((node) => {
    const animations = node.getAnimations({ subtree: true });
    for (const animation of animations) animation.pause();
    const drawing = animations.filter((animation) => animation.animationName === 'weq-intent-draw');
    const rolling = animations.filter((animation) => animation.animationName === 'weq-intent-roll');
    const path = node.querySelector('.weq-intent-loading-icon > *');
    for (const animation of drawing) {
      animation.pause();
      animation.currentTime = 500;
    }
    const first = getComputedStyle(path).strokeDashoffset;
    for (const animation of drawing) animation.currentTime = 1750;
    const complete = getComputedStyle(path).strokeDashoffset;
    const reel = node.querySelector('.weq-intent-loading-reel');
    const transforms = [1872, 2004, 2136, 2268].map((time) => {
      for (const animation of rolling) animation.currentTime = time;
      const matrix = new DOMMatrix(getComputedStyle(reel).transform);
      return { x: matrix.m41, rotation: (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI };
    });
    for (const animation of rolling) animation.currentTime = 2800;
    const afterExitOpacity = getComputedStyle(reel).opacity;
    for (const animation of animations) animation.currentTime = 1750;
    return {
      count: drawing.length,
      first,
      complete,
      positions: transforms.map((value) => value.x),
      rotations: transforms.map((value) => value.rotation),
      afterExitOpacity,
      icons: [...node.querySelectorAll('svg')].map((svg) => svg.getAttribute('class')),
      rendered: {
        stroke: getComputedStyle(path).stroke,
        color: getComputedStyle(path).color,
        opacity: getComputedStyle(path).opacity,
        reelOpacity: getComputedStyle(reel).opacity,
        dash: getComputedStyle(path).strokeDasharray,
      },
    };
  });
  assert.ok(states.count >= 2, '两枚图标均应有笔画动画');
  assert.notEqual(states.first, states.complete, '笔画应随时间描画');
  assert.equal(states.complete, '0px', '图标应在离场前描画完成');
  assert.equal(states.positions[0], 0, '描完后短暂停留再离场');
  assert.ok(states.positions[3] < states.positions[2], '图标应向左离场');
  assert.ok(states.rotations[2] < states.rotations[1], '离场应同时逆时针旋转');
  assert.equal(states.afterExitOpacity, '0', '即便下一枚尚未提交，旧图标离场后也必须保持隐藏');
  assert.ok(
    states.positions[2] - states.positions[3] > states.positions[0] - states.positions[1],
    '离场后半程应比前半程移动更快',
  );
  if (output) await mkdir(output, { recursive: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let cases = 0;
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      for (const accent of ['#075c30', '#fff3a1']) {
        await page.evaluate(
          ({ theme, accent }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.setProperty('--weq-accent-effective', accent);
          },
          { theme, accent },
        );
        const checks = await chips.evaluate((node) => {
          const pills = [...node.querySelectorAll('.weq-intent-pill')];
          return pills.every((pill) => {
            const rect = pill.getBoundingClientRect();
            const icon = pill.querySelector('svg').getBoundingClientRect();
            return (
              rect.width === 52 &&
              rect.height === 21 &&
              rect.right <= innerWidth &&
              icon.left >= rect.left &&
              icon.right <= rect.right &&
              icon.top >= rect.top &&
              icon.bottom <= rect.bottom
            );
          });
        });
        assert.ok(checks, `${width}/${theme}/${accent}: 槽位不变，图标不越界`);
        for (const icon of await chips.locator('svg').all()) {
          const pixels = await sharp(await icon.screenshot()).stats();
          assert.ok(
            pixels.channels.slice(0, 3).some((channel) => channel.stdev > 3),
            `${width}/${theme}/${accent}: 图标实际像素应非空白`,
          );
        }
        if (output && accent === '#075c30' && width !== 320) {
          await page.screenshot({ path: resolve(output, `drawing-${width}-${theme}.png`) });
          await chips.screenshot({ path: resolve(output, `chips-${width}-${theme}.png`) });
        }
        cases++;
      }
    }
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.ok(await chips.evaluate((node) => node.getAnimations({ subtree: true }).length > 0));
  const beforeCycle = await chips.locator('svg').first().getAttribute('class');
  await page.waitForFunction(
    (before) => document.querySelector('.weq-intent-loading-icon').getAttribute('class') !== before,
    beforeCycle,
    { timeout: 5000 },
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await chips.evaluate((node) => node.getAnimations({ subtree: true }).length), 0);
  assert.equal(
    await chips
      .locator('svg > *')
      .first()
      .evaluate((node) => getComputedStyle(node).strokeDashoffset),
    '0px',
    '减少动态效果时保留完整静态图标',
  );
  if (output) await chips.screenshot({ path: resolve(output, 'static.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.deepEqual(await chips.boundingBox(), initial);
  await page.evaluate(() => window.intentQa.publishResult());
  await page.waitForFunction(() =>
    document.querySelector('.weq-intent-chips').textContent.includes('闲聊'),
  );
  assert.equal(await chips.locator('.weq-intent-loading-icon').count(), 0);
  assert.deepEqual(await chips.boundingBox(), initial, '结果替换不改变布局');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      { cases, states, reducedMotion: true, stableLayout: true, errors, output },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
