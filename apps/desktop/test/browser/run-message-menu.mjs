import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/message-menu.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
const check = (condition, text) => {
  if (!condition) throw new Error(text);
};
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_STYLE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fallback = await sharp({
    create: { width: 26, height: 26, channels: 3, background: '#21a266' },
  })
    .png()
    .toBuffer();
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/_asset/emoji/')) {
      const rel = url.pathname.slice('/_asset/emoji/'.length);
      const body = process.env.WEQ_EMOJI_FIXTURE_DIR
        ? await readFile(resolve(process.env.WEQ_EMOJI_FIXTURE_DIR, rel)).catch(() => fallback)
        : fallback;
      return route.fulfill({ contentType: 'image/png', body });
    }
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/message-menu.html`,
  );
  await page.waitForFunction(() => window.menuFixture);
  for (const [theme, width, height, accent, background] of [
    ['light', 1280, 900, '#19764c', 'plain'],
    ['dark', 1280, 900, '#f4cf4c', 'grid'],
    ['light', 390, 844, '#db3f62', 'paper'],
    ['dark', 390, 844, '#b7dfdd', 'dots'],
    ['light', 640, 280, '#19764c', 'plain'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const [corner, x, y] of [
      ['top-left', 0, 0],
      ['top-right', width, 0],
      ['bottom-left', 0, height],
      ['bottom-right', width, height],
    ]) {
      await page.evaluate(
        (args) => window.menuFixture(...args),
        [x, y, width < 760, theme, accent, background],
      );
      const menu = page.getByRole('menu');
      await menu.waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.message-reaction-strip img')].every(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      );
      const geometry = await menu.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          overflow: el.scrollWidth > el.clientWidth,
          count: el.querySelectorAll('.message-action-row').length,
        };
      });
      check(
        geometry.left >= 0 &&
          geometry.top >= 0 &&
          geometry.right <= width &&
          geometry.bottom <= height &&
          !geometry.overflow,
        `${theme}/${width}/${height}/${corner}: 菜单溢出 ${JSON.stringify(geometry)}`,
      );
      check(geometry.count === 3, '按钮区不是三行');
      if (output && corner === 'top-left')
        await page.screenshot({ path: resolve(output, `${theme}-${width}-${height}.png`) });
      // disabled 按钮仍应立即提供原因，不能依赖 250ms 全局延迟。
      const reveal = page.getByRole('button', { name: '在文件夹中显示', exact: true });
      await reveal.scrollIntoViewIfNeeded();
      await reveal.hover();
      await page.waitForFunction(() =>
        document.querySelector('[role="tooltip"]')?.textContent?.includes('暂不可用'),
      );
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.menuFixture(50, 50, false, 'light', '#19764c', 'plain'));
  await page.getByRole('button', { name: '取消贴表情：赞', exact: true }).click();
  check(await page.evaluate(() => window.menuActions.includes('76:false')), '回应没有切换为取消');
  await page.getByRole('menuitem', { name: '+1', exact: true }).click();
  check(await page.evaluate(() => window.menuActions.includes('+1')), '+1 没有执行');
  await page.keyboard.press('End');
  await page.keyboard.press('Escape');
  check(
    await page.locator('#origin').evaluate((el) => document.activeElement === el),
    'Esc 未归还焦点',
  );
  await page.evaluate(() => window.menuFixture(50, 50, false, 'light', '#19764c', 'plain'));
  await page.getByRole('button', { name: '更多表情', exact: true }).click();
  const selected = page
    .getByRole('dialog', { name: '贴表情' })
    .getByRole('button', { name: '赞', exact: true });
  check((await selected.getAttribute('aria-pressed')) === 'true', '更多面板没有显示已贴状态');
  await selected.click();
  check(
    await page.evaluate(() => window.menuActions.includes('more:76:false')),
    '更多面板不能取消已贴回应',
  );
  // 在真实触屏 context 中验证长按只提示，松手不执行。
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const touchPage = await touch.newPage();
  await touchPage.goto(page.url());
  await touchPage.waitForFunction(() => window.menuFixture);
  await touchPage.evaluate(() => window.menuFixture(100, 100, true, 'light', '#19764c', 'plain'));
  const target = touchPage.getByRole('menuitem', { name: '本地删除', exact: true });
  const bounds = await target.boundingBox();
  const session = await touchPage.context().newCDPSession(touchPage);
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await touchPage.waitForFunction(
    () => document.querySelector('[role="tooltip"]')?.textContent === '本地删除',
  );
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check(
    await touchPage.evaluate(() => !window.menuActions.includes('本地删除')),
    '长按松手执行了删除',
  );
  await target.tap();
  check(await touchPage.evaluate(() => window.menuActions.includes('本地删除')), '长按后短按失效');
  await touch.close();
  check(errors.length === 0, errors.join('\n'));
  console.log(
    '消息菜单浏览器验证通过：5 组主题/尺寸、四角避让、媒体资源绘制、三行图标、禁用提示、回应取消、+1、焦点归还及真实触屏长按。',
  );
} finally {
  await browser?.close();
  await server.close();
}
