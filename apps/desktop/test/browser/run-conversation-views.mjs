import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_CONVERSATION_VIEWS_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-conversation-views'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/conversation-views.stub.ts'),
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
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const width of [1280, 390]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/conversation-views.html`,
      );
      await page.locator('.conversation-row').first().waitFor();
      await page.evaluate((theme) => {
        const store = window.conversationViewsQa.store.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#157347' : '#f6d46b');
        store.setBackground(theme === 'light' ? 'plain' : 'grid');
      }, theme);
      await page.getByRole('button', { name: '搜索会话', exact: true }).click();
      await page.getByRole('textbox', { name: '搜索会话名称或号码' }).fill('群');
      await page.locator('[data-weq-windowed-list]').evaluate((node) => {
        node.scrollTop = 500;
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      const position = await page
        .locator('[data-weq-windowed-list]')
        .evaluate((node) => node.scrollTop);
      await page.locator('[data-conversation-id="merged:group-assistant"]').click();
      await page.getByRole('button', { name: '返回常规视图', exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => window.conversationViewsQa.chat),
        '原先打开的 QQ 聊天',
      );
      assert.equal(await page.locator('[data-conversation-id]').count(), 1);
      const helperUnread = page.locator('[data-conversation-id="20001"] .row-unread');
      assert.equal(await helperUnread.textContent(), '7');
      assert.equal(await helperUnread.evaluate((node) => node.classList.contains('muted')), true);
      const helperColor = await helperUnread.evaluate((node) => {
        const probe = document.createElement('span');
        probe.style.background = 'var(--weq-qqnt-unread-muted)';
        probe.style.color = 'var(--weq-qqnt-unread-muted-ink)';
        document.body.append(probe);
        const result = {
          actual: getComputedStyle(node).backgroundColor,
          expected: getComputedStyle(probe).backgroundColor,
          ink: getComputedStyle(node).color,
          expectedInk: getComputedStyle(probe).color,
        };
        probe.remove();
        return result;
      });
      assert.equal(helperColor.actual, helperColor.expected);
      assert.equal(helperColor.ink, helperColor.expectedInk);
      if (output)
        await page.screenshot({
          path: resolve(output, `${width}-${theme}-group-assistant-unread.png`),
        });
      await page.getByRole('button', { name: '返回常规视图', exact: true }).click();
      assert.equal(
        await page.getByRole('textbox', { name: '搜索会话名称或号码' }).inputValue(),
        '群',
      );
      assert.ok(
        Math.abs(
          (await page.locator('[data-weq-windowed-list]').evaluate((node) => node.scrollTop)) -
            position,
        ) < 2,
      );
      await page.getByRole('button', { name: '退出搜索会话', exact: true }).click();
      await page.getByRole('button', { name: '多选会话', exact: true }).click();
      await page.getByRole('button', { name: '全选当前结果', exact: true }).click();
      assert.equal(
        await page
          .locator('[data-selection]')
          .evaluate((node) =>
            JSON.parse(node.textContent).scope.ids.some((id) => id.startsWith('merged:')),
          ),
        false,
      );
      await page.getByRole('button', { name: '退出多选', exact: true }).click();
      await page.getByRole('button', { name: '会话视图', exact: true }).click();
      assert.equal(await page.getByRole('menuitemradio').count(), 10);
      const badgeWidth = await page
        .locator('.row-unread')
        .first()
        .evaluate((node) => node.getBoundingClientRect().width);
      assert.ok(badgeWidth <= 40, `未读角标宽度异常：${badgeWidth}`);
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-views.png`) });
      await page.getByRole('menuitemradio', { name: 'WeQ 助手会话', exact: true }).click();
      await page.getByRole('button', { name: '会话视图', exact: true }).waitFor();
      await page.getByRole('button', { name: '添加会话', exact: true }).click();
      assert.deepEqual(await page.getByRole('menuitem').allTextContents(), [
        '新建好友克隆',
        '新建克隆体群聊',
        'QQ 号搜索',
        '群号搜索',
        '新建 WeQ 助手会话',
      ]);
      await page.keyboard.press('Escape');
      await page.locator('[data-conversation-id="assistant:assistant-one"]').click();
      await page.getByRole('region', { name: 'WeQ 助手会话', exact: true }).waitFor();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      assert.ok(overflow <= 1, `${width}/${theme}: 页面横向溢出 ${overflow}`);
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}-assistant.png`) });
      if (width <= 720) {
        await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
        await page.getByRole('button', { name: '会话视图', exact: true }).waitFor();
        assert.equal(
          await page.evaluate(() => window.conversationViewsQa.chat),
          'assistant:assistant-one',
        );
        await page.getByRole('button', { name: '会话视图', exact: true }).click();
        await page.getByRole('menuitemradio', { name: '频道私聊', exact: true }).click();
        await page.locator('[data-conversation-id="guild:node-one"]').waitFor();
        assert.equal(
          await page.evaluate(() => window.conversationViewsQa.chat),
          'assistant:assistant-one',
        );
      }
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/conversation-views.html?export`,
      );
      await page.getByRole('region', { name: '会话批量导出', exact: true }).waitFor();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.classList.toggle('dark', theme === 'dark');
      }, theme);
      assert.equal(await page.locator('.weq-conversation-batch-targets li').count(), 7);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const embeddedWidth = await page.locator('.weq-exp-dialog').evaluate((node) => ({
        dialog: node.getBoundingClientRect().width,
        pane: node.closest('.weq-conversation-batch-export').getBoundingClientRect().width,
      }));
      assert.ok(
        Math.abs(embeddedWidth.dialog - embeddedWidth.pane) <= 1,
        JSON.stringify(embeddedWidth),
      );
      const primary = await page
        .locator('.weq-exp-primary, .weq-exp-btn.is-primary')
        .evaluate((node) => {
          const probe = document.createElement('span');
          probe.style.background = 'var(--weq-accent-effective)';
          document.body.append(probe);
          const value = {
            actual: getComputedStyle(node).backgroundColor,
            expected: getComputedStyle(probe).backgroundColor,
          };
          probe.remove();
          return value;
        });
      assert.equal(primary.actual, primary.expected);
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}-batch-export.png`) });
      results.push({
        width,
        theme,
        restoredSearch: true,
        restoredPosition: position,
        aggregateExcluded: true,
        assistantInMain: true,
        overflow,
      });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases: results, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
