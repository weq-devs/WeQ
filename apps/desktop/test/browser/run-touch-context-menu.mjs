import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react()],
  optimizeDeps: { entries: ['test/browser/touch-context-menu.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/touch-context-menu.html`,
  );
  await page.waitForSelector('[data-surface]');
  let count = 0;
  for (const width of [390, 1180]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ['会话', '联系人', '消息', '图片', '空白区域', '弹窗内容']) {
      const target = page.locator(`[data-surface="${name}"] span`);
      const init = {
        pointerType: 'touch',
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: 30,
        clientY: 40,
      };
      await target.dispatchEvent('pointerdown', init);
      await page.waitForTimeout(500);
      await target.dispatchEvent('pointerup', init);
      await target.dispatchEvent('contextmenu', { button: 2 });
      await target.dispatchEvent('click');
      assert.equal(await page.locator('output').textContent(), name);
      assert.equal(await page.locator('body').getAttribute('data-menus'), String(++count));
      assert.equal(await page.locator('output').getAttribute('data-clicks'), '0');
    }
  }
  await page.locator('textarea').tap();
  await page.locator('textarea').fill('保留系统编辑');
  assert.equal(await page.locator('textarea').inputValue(), '保留系统编辑');
  await page.locator('[data-surface="会话"]').tap();
  assert.equal(await page.locator('output').getAttribute('data-clicks'), '1');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: WebKit 合成触摸长按、React 右键冒泡、portal、宽窄视口、原生事件去重、松手防误点和后续轻触',
  );
} finally {
  await browser?.close();
  await server.close();
}
