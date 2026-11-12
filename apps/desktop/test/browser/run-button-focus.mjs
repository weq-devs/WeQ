import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-button-focus'),
  plugins: [react(), tailwind()],
  optimizeDeps: {
    entries: ['test/browser/button-focus.html'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime', 'zustand'],
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
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
  const page = await browser.newPage({ reducedMotion: 'reduce', hasTouch: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_FOCUS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['light', 'dark']) {
      for (const style of ['classic', 'minimal', 'retro', 'qqnt']) {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/button-focus.html`,
        );
        await page.getByRole('button', { name: '打开弹窗' }).waitFor();
        await page.evaluate(
          ({ theme, style }) => {
            const store = window.focusTheme.getState();
            store.setPreference(theme);
            store.setComponentStyle(style);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            store.setBackground(theme === 'light' ? 'grid' : 'telegram');
          },
          { theme, style },
        );
        const trigger = page.getByRole('button', { name: '打开弹窗' });
        const next = page.getByRole('button', { name: '下一个按钮' });
        const outline = (button) =>
          button.evaluate((element) => getComputedStyle(element).outlineStyle);
        await trigger.click();
        await page.getByRole('dialog').waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
        assert.equal(await outline(trigger), 'none', `${theme}/${style}: 鼠标打开后 Esc 不描边`);
        if (output)
          await page.screenshot({
            path: resolve(output, `${theme}-${style}-${width}-pointer.png`),
          });
        await page.keyboard.press('Tab');
        assert.equal(await next.evaluate((el) => el === document.activeElement), true);
        assert.notEqual(await outline(next), 'none', '后续 Tab 显示焦点环');
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Enter');
        await page.getByRole('dialog').waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
        assert.notEqual(await outline(trigger), 'none', '键盘打开后 Esc 保留焦点环');
        const message = page.locator('[data-weq-select-id="message"]');
        const link = page.getByRole('link', { name: '链接' });
        await link.tap();
        assert.equal(await outline(link), 'none', '触摸链接不描边');
        const rect = await message.boundingBox();
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        const session = await page.context().newCDPSession(page);
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [point],
        });
        await page.waitForTimeout(600);
        assert.equal(await message.evaluate((el) => el === document.activeElement), true);
        assert.equal(await outline(message), 'none', `${theme}/${style}: 长按消息不描边`);
        assert.equal(
          await message.evaluate((el) => getComputedStyle(el).webkitTapHighlightColor),
          'rgba(0, 0, 0, 0)',
          '触摸目标不显示浏览器高亮块',
        );
        if (output)
          await page.screenshot({
            path: resolve(output, `chromium-${theme}-${style}-${width}-hold.png`),
          });
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await session.detach();
        await page.keyboard.press('Shift+Tab');
        assert.notEqual(await outline(link), 'none', '触摸后恢复键盘导航仍显示链接焦点');
        await page.keyboard.press('Tab');
        assert.notEqual(await outline(message), 'none', '键盘导航消息仍显示焦点');
        if (output)
          await page.screenshot({
            path: resolve(output, `${theme}-${style}-${width}-keyboard.png`),
          });
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
