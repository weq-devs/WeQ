import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const engine = process.env.WEQ_TOUCH_BROWSER ?? 'webkit';
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/touch-context-menu.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  optimizeDeps: { entries: ['test/browser/touch-context-menu.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
try {
  if (process.env.WEQ_STYLE_ARTIFACTS)
    await mkdir(process.env.WEQ_STYLE_ARTIFACTS, { recursive: true });
  await server.listen();
  browser = await engines[engine].launch({
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
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/touch-context-menu.html`,
  );
  await page.waitForSelector('[data-surface]');
  await page.evaluate(() => {
    for (const name of ['消息', '图片']) {
      const content = document.querySelector(`[data-surface="${name}"] span`);
      content.classList.add('message-content');
      if (name === '图片') {
        const image = document.createElement('img');
        image.alt = '长按图片';
        image.width = image.height = 32;
        image.src =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1cAAAAASUVORK5CYII=';
        content.append(image);
      }
    }
  });
  let count = 0;
  for (const width of [390, 1180]) {
    await page.setViewportSize({ width, height: 844 });
    // 必须检查真实层叠结果；只派发 contextmenu 无法发现系统文字选择与图片 callout。
    const styles = await page.evaluate(() => {
      const message = document.createElement('div');
      message.className = 'message-content';
      message.innerHTML = '<span>消息正文</span><a href="#">链接<img alt="图片"></a>';
      document.body.append(message);
      const editor = document.createElement('div');
      editor.contentEditable = 'true';
      editor.innerHTML = '<span>输入文字</span>';
      document.body.append(editor);
      const values = (element) => {
        const style = getComputedStyle(element);
        return {
          select: style.getPropertyValue('-webkit-user-select') || style.userSelect,
          callout: style.getPropertyValue('-webkit-touch-callout'),
        };
      };
      const result = {
        touch: matchMedia('(any-pointer: coarse)').matches,
        content: [message, ...message.querySelectorAll('*')].map(values),
        editors: [document.querySelector('textarea'), editor, editor.firstElementChild].map(values),
      };
      message.remove();
      editor.remove();
      return result;
    });
    assert.equal(styles.touch, true);
    for (const style of styles.content) {
      assert.equal(style.select, 'none');
      if (style.callout) assert.equal(style.callout, 'none');
    }
    for (const style of styles.editors) {
      assert.equal(style.select, 'text');
      if (style.callout) assert.equal(style.callout, 'default');
    }
    for (const name of ['会话', '联系人', '消息', '图片', '空白区域', '弹窗内容']) {
      const target = page.locator(`[data-surface="${name}"] ${name === '图片' ? 'img' : 'span'}`);
      await target.scrollIntoViewIfNeeded();
      const rect = await target.boundingBox();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const init = {
        pointerType: 'touch',
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: point.x,
        clientY: point.y,
      };
      const session = engine === 'chromium' ? await page.context().newCDPSession(page) : null;
      if (session) {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [point],
        });
        await page.waitForTimeout(650);
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await session.detach();
      } else {
        await target.dispatchEvent('pointerdown', init);
        await page.waitForTimeout(500);
        await target.dispatchEvent('pointerup', init);
      }
      await target.dispatchEvent('contextmenu', { button: 2 });
      await target.dispatchEvent('click');
      assert.equal(await page.locator('output').textContent(), name);
      assert.equal(await page.locator('body').getAttribute('data-menus'), String(++count));
      assert.equal(await page.locator('output').getAttribute('data-clicks'), '0');
      assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '');
    }
  }
  await page.locator('textarea').tap();
  await page.locator('textarea').fill('保留系统编辑');
  assert.equal(await page.locator('textarea').inputValue(), '保留系统编辑');
  await page.locator('[data-surface="会话"]').tap();
  assert.equal(await page.locator('output').getAttribute('data-clicks'), '1');
  for (const [width, theme] of [
    [390, 'light'],
    [1180, 'dark'],
  ]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const clicksBefore = Number(await page.locator('output').getAttribute('data-clicks'));
    const chip = page.locator('.msg-reaction');
    await chip.scrollIntoViewIfNeeded();
    const rect = await chip.boundingBox();
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const init = {
      ...point,
      clientX: point.x,
      clientY: point.y,
      pointerType: 'touch',
      pointerId: 1,
      isPrimary: true,
      button: 0,
    };
    const session = engine === 'chromium' ? await page.context().newCDPSession(page) : null;
    if (session) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    } else {
      await chip.dispatchEvent('pointerover', init);
      await chip.dispatchEvent('pointerdown', init);
    }
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.reaction-likers:visible').count(), 1);
    assert.equal(await page.locator('output').textContent(), '弹窗内容');
    if (session) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else {
      await chip.dispatchEvent('pointerup', init);
      await chip.dispatchEvent('click');
    }
    assert.equal(Number(await page.locator('output').getAttribute('data-clicks')), clicksBefore);
    // 浮层中的长按经 React portal 冒泡，仍不得打开底层消息菜单。
    const panel = page.locator('.reaction-likers');
    await chip.dispatchEvent('pointerover', { pointerType: 'mouse' });
    await panel.waitFor({ state: 'visible' });
    await panel.dispatchEvent('contextmenu', { button: 2 });
    assert.equal(await page.locator('output').textContent(), '弹窗内容');
    if (process.env.WEQ_STYLE_ARTIFACTS)
      await page.screenshot({
        path: resolve(process.env.WEQ_STYLE_ARTIFACTS, `reaction-${width}-${theme}.png`),
      });
    await chip.tap();
    assert.equal(
      Number(await page.locator('output').getAttribute('data-clicks')),
      clicksBefore + 1,
    );
  }
  const desktop = await browser.newPage({
    viewport: { width: 1180, height: 844 },
    hasTouch: false,
  });
  await desktop.goto(page.url());
  await desktop.waitForSelector('.message-content');
  assert.equal(
    await desktop
      .locator('.message-content')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return style.getPropertyValue('-webkit-user-select') || style.userSelect;
      }),
    'text',
  );
  await desktop.close();
  assert.deepEqual(errors, []);
  console.log(
    `PASS: ${engine} 触摸长按、React 右键冒泡、portal、宽窄视口、原生事件去重、松手防误点、贴表情单浮层和后续轻触`,
  );
} finally {
  await browser?.close();
  await server.close();
}
