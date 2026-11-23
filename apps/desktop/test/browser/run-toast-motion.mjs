import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-toast-motion'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  optimizeDeps: { entries: ['test/browser/toast-motion.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
try {
  await server.listen();
  browser = await engines[process.env.WEQ_TOAST_BROWSER ?? 'chromium'].launch({
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
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/toast-motion.html`,
  );
  await page.waitForFunction(() => window.toastMotion);
  const output = process.env.WEQ_TOAST_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  await page.setViewportSize({ width: 390, height: 900 });
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    await page.evaluate(() => window.toastMotion.reset());
    await page.locator('.weq-toast.show').nth(2).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.weq-toast-slot')].every(
        (slot) => slot.getAnimations({ subtree: true }).length === 0,
      ),
    );
    const positions = await page.evaluate(async () => {
      const existing = document.querySelector('[data-toast-key="motion-0"]');
      const positions = [existing.getBoundingClientRect().top];
      window.toastMotion.store.getState().push({
        key: 'motion-arrival',
        title: '新通知',
        ttl: 0,
      });
      const start = performance.now();
      while (performance.now() - start < 550) {
        await new Promise(requestAnimationFrame);
        positions.push(existing.getBoundingClientRect().top);
      }
      return positions;
    });
    const before = positions[0];
    const after = positions.at(-1);
    assert.ok(before - after > 20, '新横幅应在已有横幅下方占位');
    const between = positions.filter((y) => y < before - 1 && y > after + 1);
    if (reducedMotion === 'reduce') assert.equal(between.length, 0);
    else assert.ok(between.length >= 3, '新横幅展开时已有横幅应连续上移');
  }
  await page.setViewportSize({ width: 390, height: 330 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.toastMotion.reset();
    for (let index = 0; index < 5; index++)
      window.toastMotion.store.getState().push({ title: `后续通知 ${index}`, ttl: 0 });
  });
  await page.locator('.weq-toast.show').nth(7).waitFor();
  await page.waitForFunction(() => {
    const host = document.querySelector('.weq-toast-host');
    return (
      host.scrollHeight > host.clientHeight &&
      host.scrollHeight - host.clientHeight - host.scrollTop <= 2 &&
      host.getAnimations({ subtree: true }).length === 0
    );
  });
  await page.locator('.weq-toast-host').evaluate((host) => {
    host.scrollTop = 0;
  });
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    window.toastMotion.store.getState().push({ title: '阅读旧通知时收到的新通知', ttl: 0 });
  });
  await page.locator('.weq-toast.show').nth(8).waitFor();
  await page.waitForFunction(
    () => document.querySelector('.weq-toast-host').getAnimations({ subtree: true }).length === 0,
  );
  assert.equal(await page.locator('.weq-toast-host').evaluate((host) => host.scrollTop), 0);

  const results = [];
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      for (const reducedMotion of ['no-preference', 'reduce']) {
        await page.emulateMedia({ reducedMotion });
        for (const scenario of ['bottom', 'middle-expanded', 'concurrent', 'revive']) {
          await page.evaluate(
            ({ theme }) => {
              window.toastMotion.theme.getState().setPreference(theme);
              window.toastMotion.theme
                .getState()
                .setAccent(theme === 'light' ? '#006d50' : '#ffe593');
              window.toastMotion.reset();
            },
            { theme },
          );
          await page.locator('.weq-toast.show').nth(2).waitFor();
          if (scenario === 'middle-expanded')
            await page.getByRole('button', { name: '展开详情' }).nth(1).click();
          await page.waitForTimeout(500);
          if (output && scenario === 'bottom' && reducedMotion === 'no-preference')
            await page.screenshot({ path: resolve(output, `${width}-${theme}-before.png`) });
          const samples = await page.evaluate(async (scenario) => {
            const rows = [...document.querySelectorAll('.weq-toast')];
            const samples = [];
            const start = performance.now();
            let revived = false;
            const sample = () =>
              samples.push({
                time: performance.now() - start,
                y: rows[0].getBoundingClientRect().top,
                count: document.querySelectorAll('.weq-toast').length,
              });
            sample();
            rows[scenario === 'middle-expanded' ? 1 : 2]
              .querySelector('[aria-label="关闭"]')
              .click();
            if (scenario === 'concurrent') rows[1].querySelector('[aria-label="关闭"]').click();
            while (performance.now() - start < 650) {
              await new Promise(requestAnimationFrame);
              sample();
              if (scenario === 'revive' && !revived && performance.now() - start >= 140) {
                revived = true;
                window.toastMotion.store.getState().push({
                  key: 'motion-2',
                  title: '下方通知已恢复',
                  durationKind: 'long',
                  ttl: 0,
                });
              }
            }
            return samples;
          }, scenario);
          const initial = samples[0].y;
          const final = samples.at(-1).y;
          if (scenario === 'revive') {
            assert.equal(samples.at(-1).count, 3, '退场中恢复的通知不得被旧定时器移除');
            assert.ok(Math.abs(final - initial) < 1, '恢复后占位与间距应回到原位');
            assert.equal(await page.locator('.weq-toast-slot.is-leaving').count(), 0);
            results.push({ width, theme, reducedMotion, scenario });
            continue;
          }
          assert.ok(final - initial > 20, '移除后应释放横幅与间距的占位');
          assert.equal(samples.at(-1).count, scenario === 'concurrent' ? 1 : 2);
          const between = samples.filter(({ y }) => y > initial + 1 && y < final - 1);
          if (reducedMotion === 'no-preference') {
            assert.ok(between.length >= 3, `${scenario}: 上方横幅应经过多个中间位置，不能跳落`);
            const removed = samples.findIndex(({ count }) => count < 3);
            assert.ok(
              Math.abs(samples[removed].y - samples[removed - 1].y) < 3,
              `实际移除 DOM 时不应再次跳动 ${JSON.stringify({
                scenario,
                width,
                theme,
                samples: samples.slice(removed - 2, removed + 1),
              })}`,
            );
          } else {
            assert.equal(between.length, 0, '减少动态效果时不播放空间移动动画');
          }
          const box = await page.locator('.weq-toast').first().boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width, '横幅不得超出屏幕');
          if (output && scenario === 'bottom' && reducedMotion === 'no-preference')
            await page.screenshot({ path: resolve(output, `${width}-${theme}-after.png`) });
          results.push({
            width,
            theme,
            reducedMotion,
            scenario,
            intermediateFrames: between.length,
          });
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases: results.length, results, errors }));
} finally {
  await browser?.close();
  await server.close();
}
