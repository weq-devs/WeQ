import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/composer-input-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  optimizeDeps: { entries: ['test/browser/timeline.html'] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'trpc.stub.ts') },
      {
        find: /^@weq\/agentlab$/,
        replacement: resolve(root, '../../packages/agentlab/src/model_selection.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: [resolve(root, '../..')] },
  },
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
  const output = process.env.WEQ_COMPOSER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const width of [320, 402, 430, 1280]) {
    const page = await browser.newPage({
      viewport: { width, height: 874 },
      hasTouch: true,
      isMobile: width <= 760,
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    try {
      await page.addInitScript(() => {
        const viewport = Object.assign(new EventTarget(), { height: 874, offsetTop: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?mobile-input&composer-actions&count=30`,
      );
      const editor = page.locator('.composer > .composer-editor');
      const send = page.locator('.composer > .composer-send');
      await editor.waitFor();
      // 桌面 WebKit 没有刘海；只替换安全区的来源，不改被测的高度和布局公式。
      await page.addStyleTag({
        content:
          '@media(max-width:760px){.chat-pane{--mobile-composer-safe-bottom:var(--weq-mobile-safe-bottom,34px)}}',
      });
      const toolbar = await page
        .locator('.composer-tools button')
        .evaluateAll((buttons) => buttons.map((button) => button.title));
      assert.equal(await editor.getAttribute('enterkeyhint'), 'send');
      assert.equal(await send.isVisible(), width > 760);
      assert(await send.isDisabled());
      const sendCurrentMessage = async () => {
        if (width <= 760) await editor.press('Enter');
        else await send.tap();
      };
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          window.visualViewport.height = 874;
          window.visualViewport.dispatchEvent(new Event('resize'));
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.background = theme === 'light' ? 'paper' : 'dots';
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'light' ? '#15764a' : '#ebbd51',
          );
        }, theme);
        await editor.fill('连续发送第一条');
        if (width <= 760) {
          const field = await editor.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const composer = node.closest('.composer');
            const parent = composer.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              left: box.left - parent.left,
              right: parent.right - box.right,
              paddingLeft: style.paddingLeft,
              paddingRight: style.paddingRight,
              radius: style.borderRadius,
            };
          });
          assert.equal(await send.isVisible(), false, '竖屏不显示独立发送键');
          assert.equal(field.left, field.right, JSON.stringify(field));
          assert.equal(field.paddingLeft, field.paddingRight, '正文仍为发送键预留空白');
          assert.equal(field.radius, '8px');
          const beforePadding = await page
            .locator('.composer')
            .evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingBottom));
          await page.evaluate(() => {
            window.visualViewport.height = 430;
            window.visualViewport.dispatchEvent(new Event('resize'));
          });
          const geometry = await page.evaluate(() => {
            const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
            const composer = rect('.composer');
            const toolbar = rect('.composer-tools');
            return {
              height: composer.height,
              bottom: composer.bottom,
              gap: composer.bottom - toolbar.bottom,
              padding: Number.parseFloat(
                getComputedStyle(document.querySelector('.composer')).paddingBottom,
              ),
            };
          });
          assert.equal(beforePadding - geometry.padding, 34, JSON.stringify(geometry));
          assert(Math.abs(geometry.bottom - 430) < 1, '输入区没有跟随键盘可视视口');
          assert(geometry.gap <= 6.1, '工具栏下方仍留有额外安全区空白');
        }
        await sendCurrentMessage();
        assert(
          await editor.evaluate((node) => document.activeElement === node),
          '发送导致输入框失焦',
        );
        assert.equal(await editor.textContent(), '');
        await editor.fill('连续发送第二条');
        await editor.press('Enter');
        assert(await editor.evaluate((node) => document.activeElement === node));
        assert.equal(await editor.textContent(), '');
        assert.deepEqual((await page.evaluate(() => window.timelineTest.sentBodies())).slice(-2), [
          '连续发送第一条',
          '连续发送第二条',
        ]);
        if (width <= 760) {
          await editor.fill('前后');
          await editor.evaluate((node) => {
            const range = document.createRange();
            range.setStart(node.firstChild, 1);
            range.collapse(true);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
          });
          await page.locator('.composer-tools button[title="表情"]').tap();
          assert(
            !(await editor.evaluate((node) => document.activeElement === node)),
            '表情面板未收起键盘焦点',
          );
          await page.evaluate(() => {
            window.visualViewport.height = 874;
            window.visualViewport.dispatchEvent(new Event('resize'));
          });
          await page.locator('.emoji-tabs button[title="颜文字"]').tap();
          const characters = page.locator('.kaomoji-grid button');
          const glyphs = [
            await characters.nth(0).locator('strong').textContent(),
            await characters.nth(1).locator('strong').textContent(),
          ];
          await characters.nth(0).tap();
          await characters.nth(1).tap();
          assert(await page.locator('.emoji-panel').isVisible());
          assert(
            !(await editor.evaluate((node) => document.activeElement === node)),
            '选表情重新唤起系统键盘',
          );
          assert.equal(
            await editor.textContent(),
            `前${glyphs.join('')}后`,
            '连续表情插入位置改变',
          );
          await editor.tap();
          await page.locator('.emoji-panel').waitFor({ state: 'detached' });
          await page.evaluate(() => {
            window.visualViewport.height = 430;
            window.visualViewport.dispatchEvent(new Event('resize'));
          });
          await sendCurrentMessage();
          await editor.fill('中文选词');
          await editor.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true });
          assert.equal(await editor.textContent(), '中文选词');
          await editor.fill('多行正文\n'.repeat(10));
          const expand = page.locator('.mobile-composer-expand-button');
          await expand.waitFor({ state: 'visible' });
          const expandFits = await page.evaluate(() => {
            const editor = document.querySelector('.composer > .composer-editor');
            const field = editor.getBoundingClientRect();
            const expand = document
              .querySelector('.mobile-composer-expand-button')
              .getBoundingClientRect();
            return (
              expand.right <= field.right &&
              expand.left >=
                field.right - Number.parseFloat(getComputedStyle(editor).paddingRight) &&
              expand.top >= field.top &&
              expand.bottom <= field.bottom
            );
          });
          assert(expandFits, '长文展开按钮超出输入框或遮挡正文');
          await expand.tap();
          const expanded = page.locator('.mobile-composer-expanded-editor');
          assert.equal(await expanded.getAttribute('enterkeyhint'), 'enter');
          await page.waitForFunction(
            () =>
              document.activeElement === document.querySelector('.mobile-composer-expanded-editor'),
          );
          await expanded.fill('第一行');
          assert.equal(await expanded.textContent(), '第一行');
          await expanded.press('Enter');
          await page.keyboard.type('第二行');
          assert.equal(
            (await expanded.innerText()).replaceAll('\u200b', '').trim(),
            '第一行\n第二行',
          );
          const expandedSend = await page.locator('.composer-send-expanded').boundingBox();
          assert(expandedSend.y + expandedSend.height <= 430, '长文发送键被键盘遮挡');
          if (output)
            await page.screenshot({
              path: resolve(output, `${theme}-${width}-expanded.png`),
              clip: { x: 0, y: 0, width, height: 430 },
            });
          await page.locator('.composer-send-expanded').tap();
          await page.locator('.mobile-composer-expanded').waitFor({ state: 'detached' });
        }
        assert.deepEqual(
          await page
            .locator('.composer-tools button')
            .evaluateAll((buttons) => buttons.map((button) => button.title)),
          toolbar,
          '工具栏入口或顺序变化',
        );
        if (output)
          await page.screenshot({
            path: resolve(output, `${theme}-${width}-input.png`),
            clip: { x: 0, y: 0, width, height: width <= 760 ? 430 : 874 },
          });
        if (width <= 760) {
          // 超级表情预览隐藏正文、没有键盘，单独复核该布局的确认入口。
          await page.locator('.composer').evaluate((node) => node.classList.add('has-single-send'));
          assert(await send.isVisible(), '无正文键盘的超级表情预览缺少发送入口');
          await page
            .locator('.composer')
            .evaluate((node) => node.classList.remove('has-single-send'));
          assert.equal(await send.isVisible(), false);
        }
        results.push({ width, theme });
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  }
  console.log(JSON.stringify({ results }));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
