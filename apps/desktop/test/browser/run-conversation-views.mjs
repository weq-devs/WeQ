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
  const page = await browser.newPage({ reducedMotion: 'reduce', hasTouch: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  const swipe = async ({ x = 4, dx = 160, dy = 0, cancel = false } = {}) => {
    const transform = await page.locator('.weq-conversation-directory').evaluate(
      async (target, { x, dx, dy, cancel }) => {
        const y = target.getBoundingClientRect().top + 160;
        const dispatch = (type, clientX, clientY, end = false) => {
          const touch = new Touch({ identifier: 1, target, clientX, clientY });
          target.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: end ? [] : [touch],
              changedTouches: [touch],
            }),
          );
        };
        dispatch('touchstart', x, y);
        dispatch('touchmove', x + dx, y + dy);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const transform = target.style.transform;
        dispatch(cancel ? 'touchcancel' : 'touchend', x + dx, y + dy, true);
        return transform;
      },
      { x, dx, dy, cancel },
    );
    await page.waitForFunction(() => !document.querySelector('[data-mobile-swiping]'));
    return transform;
  };
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
      if (width <= 720) {
        for (const gesture of [
          { dx: 20 },
          { dx: 20, dy: 80 },
          { dx: -80 },
          { x: 80 },
          { cancel: true },
        ]) {
          await swipe(gesture);
          assert.ok(await page.getByRole('button', { name: '返回常规视图' }).isVisible());
        }
        await swipe();
        await page.locator('[data-conversation-id="merged:group-assistant"]').waitFor();
      } else await page.getByRole('button', { name: '返回常规视图', exact: true }).click();
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
      if (width <= 720) {
        assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), false);
        for (const id of ['merged:clone', 'merged:assistant']) {
          await page.locator(`[data-conversation-id="${id}"]`).click();
          await page.getByRole('button', { name: '返回常规视图', exact: true }).waitFor();
          await swipe();
          await page.locator(`[data-conversation-id="${id}"]`).waitFor();
          assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), false);
        }
        await page.locator('[data-conversation-id="merged:group-assistant"]').click();
        assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), true);
        await page.locator('[data-conversation-id="merged:group-assistant"]').waitFor();
        assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), false);
      }
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
        swipeReturn: width <= 720,
      });
    }
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 360, height: 800 });
  for (const theme of ['light', 'dark']) {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/conversation-views.html`,
    );
    await page.locator('.conversation-row').first().waitFor();
    await page.evaluate((theme) => {
      window.conversationViewsQa.store.getState().setPreference(theme);
    }, theme);
    for (const [id, keyword] of [
      ['merged:group-assistant', '群助手'],
      ['merged:clone', '克隆'],
      ['merged:assistant', '助手'],
    ]) {
      await page.getByRole('button', { name: '搜索会话', exact: true }).click();
      await page.getByRole('textbox', { name: '搜索会话名称或号码' }).fill(keyword);
      await page.locator(`[data-conversation-id="${id}"]`).click();
      await page.getByRole('button', { name: '返回常规视图', exact: true }).waitFor();
      await swipe({ cancel: true });
      assert.ok(await page.getByRole('button', { name: '返回常规视图' }).isVisible());
      assert.equal(await swipe(), 'translateX(160px)');
      await page.locator(`[data-conversation-id="${id}"]`).waitFor();
      assert.equal(
        await page.locator('.weq-conversation-directory').evaluate((node) => node.style.transform),
        '',
      );
      assert.equal(await page.evaluate(() => window.weqMobileNavigation.back()), false);
      assert.equal(
        await page.getByRole('textbox', { name: '搜索会话名称或号码' }).inputValue(),
        keyword,
      );
      await page.getByRole('button', { name: '退出搜索会话', exact: true }).click();
    }
    if (output) await page.screenshot({ path: resolve(output, `360-${theme}-swipe-return.png`) });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases: results, normalMotionSwipeCases: 6, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
