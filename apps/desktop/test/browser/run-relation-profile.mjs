import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-relation-profile'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/relation-profile.stub.ts'),
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      window.relationLastDraw = performance.now();
      window.relationDrawnTexts = [];
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      window.relationDrawnTexts.push(text);
      return fillText.call(this, text, ...args);
    };
  });
  const output = process.env.WEQ_RELATION_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/relation-profile.html`,
      );
      await page.evaluate((theme) => {
        window.relationProfileQa.theme.getState().setPreference(theme);
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#e08aa0' : '#287b53',
        );
      }, theme);
      await page.locator('.weq-relhome-cta').click();
      await page.waitForFunction(
        () => window.relationLastDraw && performance.now() - window.relationLastDraw > 600,
      );
      assert(
        await page.evaluate(() => window.relationDrawnTexts.includes('合成群友')),
        '夹具中的固定昵称应已显示',
      );
      const remarkSwitch = page.getByRole('switch', { name: '显示备注名', exact: true });
      await remarkSwitch.click();
      assert.equal(await remarkSwitch.getAttribute('aria-checked'), 'true');
      await page.waitForTimeout(100);
      const texts = await page.evaluate(() => window.relationDrawnTexts);
      assert(texts.includes('备注示例'), '固定昵称应直接替换为备注名');
      assert(!texts.includes('合成群友'), '固定标签开启备注后不应仍绘制昵称');
      assert(texts.includes('合'), '头像中的昵称首字应保持不变');
      assert(!texts.includes('备'), '头像中的昵称首字不随备注开关变化');
      const redrawnAt = await page.evaluate(() => window.relationLastDraw);
      await page.waitForTimeout(500);
      assert.equal(
        await page.evaluate(() => window.relationLastDraw),
        redrawnAt,
        '切换名称不重启布局',
      );
      assert(
        await page
          .locator('.weq-graph-controls')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
        '下方选项不横向溢出',
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}-controls.png`) });
      for (const [mode, label, title] of [
        ['people', '合成群友', '用户资料'],
        ['groups', '合成群聊', '群资料'],
      ]) {
        if (mode === 'groups') {
          await page.getByRole('button', { name: '群聊网络', exact: true }).click();
          // 上一轮拖动已关闭自动取景；切模式后由真实按钮恢复，保留产品的镜头约定。
          await page.getByRole('button', { name: '适应全部', exact: true }).click();
        }
        const canvas = page.locator('canvas');
        // 等布局稳定后从真实画布读取头像像素，再用悬浮名称确认点击对象。
        await page.waitForFunction(
          () => window.relationLastDraw && performance.now() - window.relationLastDraw > 600,
        );
        const points = await canvas.evaluate((canvas) => {
          const ctx = canvas.getContext('2d');
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const bounds = canvas.getBoundingClientRect();
          const points = [];
          const stride = bounds.width < 400 ? 4 : 8;
          for (let y = stride; y < canvas.height - stride; y += stride) {
            for (let x = stride; x < canvas.width - stride; x += stride) {
              const i = (y * canvas.width + x) * 4;
              if (
                data[i + 3] > 240 &&
                Math.max(data[i], data[i + 1], data[i + 2]) -
                  Math.min(data[i], data[i + 1], data[i + 2]) >
                  50
              )
                points.push({
                  x: bounds.x + (x * bounds.width) / canvas.width,
                  y: bounds.y + (y * bounds.height) / canvas.height,
                });
            }
          }
          return points;
        });
        assert(points.length > 0, '图谱画布不能空白');
        let target;
        for (const point of points) {
          await page.mouse.move(point.x, point.y);
          const hovered = await page.evaluate(
            () =>
              new Promise((resolve) => {
                requestAnimationFrame(() =>
                  resolve(document.querySelector('.weq-graph-tooltip strong')?.textContent ?? ''),
                );
              }),
          );
          if (hovered === label) {
            target = point;
            break;
          }
        }
        assert(target, `未找到${label}`);
        await page.mouse.down();
        await page.mouse.move(target.x + 30, target.y + 20, { steps: 4 });
        await page.mouse.up();
        assert.equal(
          await page.getByRole('dialog', { name: title, exact: true }).count(),
          0,
          '拖动不能打开名片',
        );
        await page.mouse.down();
        await page.locator('.weq-graph-canvas-wrap').dispatchEvent('pointercancel');
        await page.mouse.up();
        assert.equal(
          await page.getByRole('dialog', { name: title, exact: true }).count(),
          0,
          '取消指针操作不能打开名片',
        );
        await page.mouse.click(target.x + 30, target.y + 20);
        const card = page.getByRole('dialog', { name: title, exact: true });
        await card.waitFor();
        await card.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
        });
        const bounds = await card.boundingBox();
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${theme}-${mode}.png`) });
        assert(
          bounds &&
            bounds.x >= 0 &&
            bounds.y >= 0 &&
            bounds.x + bounds.width <= width + 1 &&
            bounds.y + bounds.height <= 845,
          JSON.stringify({ width, theme, mode, bounds, target }),
        );
        assert(Math.abs(bounds.x - target.x) < bounds.width + 45, '名片应靠近点击的头像');
        assert.equal(await page.locator('.weq-graph-detail').count(), 0);
        await page.keyboard.press('Escape');
        await card.waitFor({ state: 'detached' });
        cases++;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
