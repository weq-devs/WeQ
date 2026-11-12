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
  cacheDir: resolve(root, 'node_modules/.vite-conversation-context'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
  const output = process.env.WEQ_STYLE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  const ids = () =>
    page
      .locator('[data-conversation-id]')
      .evaluateAll((rows) => rows.map((row) => row.dataset.conversationId));
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['light', 'dark']) {
      for (const style of ['qqnt', 'classic', 'minimal', 'retro']) {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/conversation-context.html`,
        );
        const first = page.locator('[data-conversation-id="10001"]');
        await first.waitFor();
        await page.evaluate(
          ({ theme, style }) => {
            const qa = window.conversationContextQa;
            const store = qa.theme.getState();
            store.setPreference(theme);
            store.setComponentStyle(style);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            store.setBackground(theme === 'light' ? 'grid' : 'telegram');
            qa.enable(true);
          },
          { theme, style },
        );
        await first.hover();
        await page.evaluate(() => window.conversationContextQa.update());
        await page.waitForTimeout(50);
        assert.deepEqual(await ids(), ['10001', '10002'], '准备点击时目标不移动');
        await first.click({ button: 'right' });
        const menu = page.getByRole('menu');
        await menu.waitFor();
        assert.match(
          await menu.locator('.weq-conversation-actions-target').innerText(),
          /产品讨论组/,
        );
        assert.equal(
          await first.evaluate((row) => row.classList.contains('is-context-target')),
          true,
        );
        assert.equal(await page.locator('output').getAttribute('data-selected'), '');
        const rect = await menu.boundingBox();
        assert.ok(rect.x >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= 800);
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${theme}-${style}.png`) });
        await menu.getByRole('menuitem', { name: '标为已读', exact: true }).click();
        assert.equal(await page.locator('output').getAttribute('data-marked'), '10001');
        await page.mouse.move(width - 1, 799);
        await page.waitForTimeout(50);
        assert.deepEqual(await ids(), ['10002', '10001']);
        await page.locator('[data-conversation-id="10002"]').click({ button: 'right' });
        await menu.waitFor();
        const overflow = await menu
          .locator('.weq-conversation-actions-target')
          .evaluate((el) => el.scrollWidth > el.clientWidth);
        assert.equal(overflow, false, '长标题不能横向溢出');
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.conversationContextQa.assistant());
        const assistant = page.locator('[data-conversation-id="merged:group-assistant"]');
        for (const selecting of [false, true]) {
          if (selecting) {
            await page.getByRole('button', { name: '多选会话', exact: true }).click();
            await page.getByRole('button', { name: '全选当前结果', exact: true }).click();
          }
          await assistant.click({ button: 'right' });
          await menu.waitFor();
          assert.equal(await menu.getAttribute('aria-label'), '群助手的会话操作');
          assert.equal(
            await menu.locator('.weq-conversation-actions-target small').innerText(),
            '内含 2 个会话',
          );
          assert.equal(await menu.locator('.weq-conversation-actions-target .avatar').count(), 0);
          assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['置顶']);
          assert.equal(await page.locator('.is-context-target').count(), 1);
          const assistantRect = await menu.boundingBox();
          assert.ok(
            assistantRect.x >= 0 &&
              assistantRect.x + assistantRect.width <= width &&
              assistantRect.y + assistantRect.height <= 800,
          );
          if (output && !selecting)
            await page.screenshot({
              path: resolve(output, `${width}-${theme}-${style}-assistant.png`),
            });
          await menu.getByRole('menuitem', { name: '置顶', exact: true }).click();
          await assistant.click({ button: 'right' });
          assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['取消置顶']);
          await menu.getByRole('menuitem', { name: '取消置顶', exact: true }).click();
          assert.equal(await page.locator('output').getAttribute('data-marked'), '10001');
          if (selecting)
            assert.match(await page.locator('.weq-directory-toolbar').innerText(), /已选 2/);
        }
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
