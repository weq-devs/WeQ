import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-notification-navigation'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  optimizeDeps: { entries: ['test/browser/notification-navigation.html'] },
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/notification-navigation.html`,
  );
  await page.waitForFunction(() => window.notificationQa);
  const output = process.env.WEQ_NOTIFICATION_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  const widths = process.env.WEQ_NOTIFICATION_VIEWPORT
    ? [Number(process.env.WEQ_NOTIFICATION_VIEWPORT)]
    : [320, 390, 1280];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        window.notificationQa.theme.getState().setPreference(theme);
        window.notificationQa.theme.getState().setAccent(theme === 'light' ? '#006d50' : '#ffe593');
        window.notificationQa.reset();
      }, theme);
      await page.locator('.weq-toast.show').first().waitFor();
      if ((await page.locator('.weq-toast-open').count()) !== 2)
        throw Error('普通复制提示不应出现来源动作');
      const box = await page.locator('.weq-toast').first().boundingBox();
      if (!box || box.x < 0 || box.x + box.width > width + 1)
        throw Error(`横幅超出屏幕（${width}px / ${theme}）：${JSON.stringify(box)}`);
      await page.getByRole('button', { name: '展开详情' }).click();
      if (await page.evaluate(() => window.notificationQa.routes.length))
        throw Error('展开详情触发了跳转');
      await page.getByRole('button', { name: '复制错误信息' }).click();
      if (await page.evaluate(() => window.notificationQa.routes.length))
        throw Error('复制触发了跳转');
      await page.evaluate(() => {
        const node = document.querySelector('.weq-toast-title');
        node.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
      });
      if (await page.evaluate(() => window.notificationQa.routes.length))
        throw Error('单独松开指针触发了跳转');
      await page.evaluate(() => {
        const node = document.querySelector('.weq-toast-title');
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        node.click();
      });
      if (await page.evaluate(() => window.notificationQa.routes.length))
        throw Error('拖选文字触发了跳转');
      await page.evaluate(() => document.getSelection().removeAllRanges());
      await page.locator('.weq-toast-title').first().click();
      if (
        (await page.evaluate(() => window.notificationQa.routes.at(-1)?.conv)) !== 'fixture-group'
      )
        throw Error('未定位到具体消息来源');
      await page.getByRole('button', { name: '播放样例语音' }).click();
      if ((await page.evaluate(() => window.notificationQa.plays())) !== 1)
        throw Error('独立播放动作未执行');
      if ((await page.evaluate(() => window.notificationQa.routes.length)) !== 1)
        throw Error('播放触发了导航');
      const keyboard = page.getByRole('button', { name: '定位通知来源' });
      await keyboard.focus();
      await keyboard.press('Enter');
      if ((await page.evaluate(() => window.notificationQa.routes.at(-1)?.id)) !== 'export:fixture')
        throw Error('键盘未定位任务');
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      cases++;
    }
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => window.notificationQa.reset(true));
  const openMail = page.getByRole('button', { name: '打开这封邮件' });
  await openMail.waitFor();
  const stackBottomBefore = await page
    .locator('.weq-toast-host')
    .evaluate((stack) => stack.getBoundingClientRect().bottom);
  await openMail.click();
  const mail = await page.evaluate(() => ({
    arrived: !document.querySelector('.weq-mail-retained').hidden,
    bannerVisible: Boolean(document.querySelector('[aria-label="打开这封邮件"]')),
    stackBottom: document.querySelector('.weq-toast-host').getBoundingClientRect().bottom,
  }));
  if (!mail.arrived || mail.bannerVisible)
    throw Error(`打开邮箱时应立即收起已点的通知：${JSON.stringify(mail)}`);
  if (mail.stackBottom !== stackBottomBefore)
    throw Error(`进入邮箱后其他横幅的底边移动：${stackBottomBefore}px → ${mail.stackBottom}px`);
  if (errors.length) throw Error(errors.join('\n'));
  console.log(
    JSON.stringify({
      cases,
      selection: true,
      keyboard: true,
      independentActions: true,
      mail,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
