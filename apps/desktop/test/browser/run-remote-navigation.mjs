import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/mobile-surfaces.stub.ts'),
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
  browser = await webkit.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/remote-navigation.html`,
  );
  await page.waitForSelector('.fixture-conversation');
  await page.locator('.weq-mobile-header [aria-label="连接菜单"]').click();
  assert.equal(await page.locator('body').getAttribute('data-menu-calls'), '1');
  await page.getByText('合成会话', { exact: true }).first().click();
  await page.waitForSelector('.app-shell-root[data-mobile-detail]');
  await page.getByRole('textbox', { name: '消息草稿' }).fill('返回后保留的草稿');
  const swipe = async (distance) =>
    page.evaluate(async (distance) => {
      const root = document.querySelector('.app-shell-root');
      const dispatch = (name, x, end = false) => {
        const touch = { identifier: 1, target: root, clientX: x, clientY: 280 };
        const event = new Event(name, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: end ? [] : [touch] },
          changedTouches: { value: [touch] },
        });
        root.dispatchEvent(event);
      };
      dispatch('touchstart', 4);
      dispatch('touchmove', 4 + distance);
      const transform = document.querySelector('.chat-main').style.transform;
      // 短距离慢拖必须取消，不能因合成事件速度过高误算为快甩。
      await new Promise((resolve) => setTimeout(resolve, 150));
      dispatch('touchend', 4 + distance, true);
      return transform;
    }, distance);
  assert.equal(await swipe(20), 'translateX(20px)');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.app-shell-root').getAttribute('data-mobile-detail'), 'true');
  assert.equal(
    await page.getByRole('textbox', { name: '消息草稿' }).inputValue(),
    '返回后保留的草稿',
  );
  await page.getByRole('button', { name: '打开设置' }).click();
  await page.getByRole('button', { name: '外观分类' }).click();
  await page.getByRole('textbox', { name: '设置输入' }).fill('设置草稿');
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('button:text("外观分类")');
  await page.evaluate(() => window.weqMobileNavigation.back());
  await page.waitForSelector('.fixture-settings', { state: 'detached' });
  assert.equal(
    await page.getByRole('textbox', { name: '消息草稿' }).inputValue(),
    '返回后保留的草稿',
  );
  await swipe(160);
  await page.waitForFunction(
    () => !document.querySelector('.app-shell-root').hasAttribute('data-mobile-detail'),
  );
  assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), false);
  await page.getByRole('button', { name: '联系人', exact: true }).click();
  await page.getByRole('button', { name: '消息', exact: true }).click();
  assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), false);
  const output = process.env.WEQ_MOBILE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => window.remoteNavigationQa.theme(theme), theme);
      await page.waitForTimeout(100);
      if (width <= 760) {
        const bounds = await page.locator('.weq-mobile-header').evaluate((header) =>
          [...header.querySelectorAll('button')]
            .map((button) => {
              const rect = button.getBoundingClientRect();
              return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
            })
            .filter((rect) => rect.width > 0),
        );
        assert.ok(
          bounds.every(
            (rect) =>
              rect.left >= 0 && rect.right <= width && rect.width >= 44 && rect.height >= 44,
          ),
        );
      }
      if (output)
        await page.screenshot({ path: resolve(output, `remote-root-${width}-${theme}.png`) });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByText('合成会话', { exact: true }).first().click();
  await page.locator('.chat-header [aria-label="连接菜单"]').click();
  assert.equal(await page.locator('body').getAttribute('data-menu-calls'), '2');
  if (output) await page.screenshot({ path: resolve(output, 'remote-chat-dark.png') });
  await page.locator('.back-button').click();
  await page.waitForFunction(
    () => !document.querySelector('.app-shell-root').hasAttribute('data-mobile-detail'),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: WebKit 菜单、会话与设置多级返回、侧滑完成/取消、草稿保留、根标签、320/390/1180 深浅色与减少动态效果',
  );
} finally {
  await browser?.close();
  await server.close();
}
