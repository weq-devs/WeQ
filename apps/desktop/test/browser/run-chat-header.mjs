import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const focused = process.env.WEQ_HEADER_FOCUSED === '1';
const { webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/chat-header-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  optimizeDeps: { entries: ['test/browser/chat-header.html'] },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'trpc.stub.ts') },
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
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
let browser;
try {
  await server.listen();
  browser = await webkit.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('src')?.includes('/groupluckyword/')) {
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"/>',
      });
    }
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/chat-header.html`,
  );
  await page.waitForSelector('.chat-pane');
  const output = process.env.WEQ_HEADER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  const more = () => page.getByRole('button', { name: '更多会话操作', exact: true });
  const menu = () => page.getByRole('menu', { name: '会话操作', exact: true });
  const headerMetrics = (selector) =>
    page.locator(selector).evaluate((header) => {
      const box = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      const title = getComputedStyle(
        header.querySelector('.weq-mobile-self-identity strong, .chat-title > strong'),
      );
      return {
        bounds: box(header),
        title: {
          fontSize: title.fontSize,
          fontWeight: title.fontWeight,
          lineHeight: title.lineHeight,
        },
        actions: [...header.querySelectorAll('button')]
          .filter((button) =>
            ['全局搜索', '连接菜单', '搜索聊天记录', '更多会话操作'].includes(
              button.getAttribute('aria-label'),
            ),
          )
          .map(box),
      };
    });
  if (!focused) {
    for (const width of [320, 390, 430, 760]) {
      await page.setViewportSize({ width, height: 844 });
      for (const componentStyle of focused ? ['classic'] : ['classic', 'retro', 'qqnt']) {
        for (const theme of focused ? ['light'] : ['light', 'dark']) {
          await page.evaluate(
            ({ componentStyle, theme }) => {
              document.documentElement.dataset.componentStyle = componentStyle;
              document.documentElement.dataset.theme = theme;
              window.chatHeaderQa.home(true);
            },
            { componentStyle, theme },
          );
          await page.locator('.weq-mobile-header').waitFor();
          const home = await headerMetrics('.weq-mobile-header');
          if (output && !focused && width === 390 && componentStyle === 'classic')
            await page.screenshot({ path: resolve(output, `home-${theme}.png`) });
          await page.evaluate(() => window.chatHeaderQa.home(false));
          await more().waitFor();
          const chat = await headerMetrics('.chat-header');
          if (output && !focused && width === 390 && componentStyle === 'classic')
            await page.screenshot({ path: resolve(output, `chat-${theme}.png`) });
          assert(
            JSON.stringify({ bounds: home.bounds, title: home.title }) ===
              JSON.stringify({ bounds: chat.bounds, title: chat.title }),
            `首页与会话顶栏跳位 ${width}/${componentStyle}/${theme}: ${JSON.stringify({ home, chat })}`,
          );
          assert(chat.actions.length === 1, '竖屏右侧只保留更多入口');
          results.push({ width, componentStyle, theme, stableActions: chat.actions });
        }
      }
    }
    await page.evaluate(() => {
      document
        .querySelector('.app-shell-root')
        .style.setProperty('--weq-mobile-header-height', '115px');
      window.chatHeaderQa.home(true);
    });
    await page.locator('.weq-mobile-header').waitFor();
    const safeHome = await headerMetrics('.weq-mobile-header');
    await page.evaluate(() => window.chatHeaderQa.home(false));
    await more().waitFor();
    const safeChat = await headerMetrics('.chat-header');
    assert(
      JSON.stringify(safeHome.bounds) === JSON.stringify(safeChat.bounds),
      '增加安全区高度后顶栏高度不一致',
    );
    assert(safeChat.bounds.height === 115, 'QQ NT 风格未沿用顶栏高度');
    await page.evaluate(() => {
      document.querySelector('.app-shell-root').style.removeProperty('--weq-mobile-header-height');
      document.documentElement.dataset.componentStyle = 'classic';
    });
  }
  for (const kind of ['direct', 'group']) {
    await page.evaluate((kind) => window.chatHeaderQa.kind(kind), kind);
    for (const [width, height] of focused
      ? [
          [390, 844],
          [320, 480],
        ]
      : [
          [320, 640],
          [390, 844],
          [430, 760],
          [320, 480],
        ]) {
      await page.setViewportSize({ width, height });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.background = theme === 'dark' ? 'grid' : 'paper';
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'dark' ? '#efc561' : '#9d285d',
          );
        }, theme);
        await more().waitFor();
        const geometry = await page.locator('.chat-header').evaluate((header) => {
          const rect = header.getBoundingClientRect();
          const buttons = [...header.querySelectorAll('button')].filter(
            (button) => button.getBoundingClientRect().width,
          );
          return {
            height: rect.height,
            buttons: buttons.map((button) => {
              const box = button.getBoundingClientRect();
              return {
                label: button.getAttribute('aria-label'),
                left: box.left,
                right: box.right,
                top: box.top,
                bottom: box.bottom,
              };
            }),
          };
        });
        assert(geometry.height <= 65, `标题栏不是单行：${JSON.stringify(geometry)}`);
        assert(
          geometry.buttons.every(
            (box) =>
              box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= geometry.height,
          ),
          '标题栏按钮溢出',
        );
        assert(
          (await page.locator('.chat-header .chat-actions > button').count()) === 1,
          `竖屏常驻操作应只有更多：${await page.locator('.chat-header').evaluate((header) => header.outerHTML)}`,
        );
        await more().click();
        await menu()
          .waitFor({ timeout: 5000 })
          .catch(async (error) => {
            console.error({
              kind,
              width,
              height,
              theme,
              errors,
              state: await more().getAttribute('aria-expanded'),
            });
            throw error;
          });
        const labels = await menu().getByRole('menuitem').allTextContents();
        const expected = [
          ...(kind === 'group' ? ['反馈 Bug'] : []),
          '搜索',
          '消息',
          '工具',
          '会话设置',
        ];
        assert(JSON.stringify(labels) === JSON.stringify(expected), `一级菜单不一致：${labels}`);
        await menu().getByRole('menuitem', { name: '消息', exact: true }).click();
        const messages = await menu()
          .getByRole('group', { name: '消息', exact: true })
          .getByRole('menuitem')
          .allTextContents();
        assert(
          JSON.stringify(messages) ===
            JSON.stringify([
              ...(kind === 'group' ? ['重要消息'] : []),
              '已撤回消息',
              '已删除消息',
              '添加本地消息',
            ]),
          `消息分组不一致：${messages}`,
        );
        if (output && focused && kind === 'group' && width === 390 && theme === 'light')
          await page.screenshot({ path: resolve(output, 'mobile-messages.png') });
        await menu().getByRole('menuitem', { name: '工具', exact: true }).click();
        assert(
          (await menu().getByRole('group', { name: '消息', exact: true }).count()) === 0,
          '切换后旧分组未收起',
        );
        const tools = await menu()
          .getByRole('group', { name: '工具', exact: true })
          .getByRole('menuitem')
          .allTextContents();
        assert(
          JSON.stringify(tools) ===
            JSON.stringify([
              '拉取漫游消息',
              '会话分析',
              '导出聊天记录',
              ...(kind === 'group' ? ['导出群成员名单', '群聊侧栏'] : []),
              '连接菜单',
            ]),
          `工具分组不一致：${tools}`,
        );
        const bounds = await menu().boundingBox();
        const trigger = await more().boundingBox();
        assert(
          bounds.y >= Math.max(geometry.height, trigger.y + trigger.height) &&
            bounds.x >= 0 &&
            bounds.x + bounds.width <= width + 1 &&
            bounds.y + bounds.height <= height,
          '下拉菜单超出视口或覆盖标题栏',
        );
        if (output && !focused && width === 390)
          await page.screenshot({ path: resolve(output, `${kind}-${theme}.png`) });
        await menu().getByRole('menuitem', { name: '会话设置', exact: true }).click();
        assert((await menu().count()) === 0, '选择后菜单未关闭');
        assert(
          (await page.evaluate(() => window.chatHeaderQa.calls.at(-1))) === '设置',
          '未触发设置',
        );
        await more().click();
        await page.keyboard.press('Escape');
        assert((await menu().count()) === 0, 'Escape 未关闭菜单');
        await more().click();
        await page.mouse.click(8, geometry.height + 8);
        assert((await menu().count()) === 0, '点外未关闭菜单');
        results.push({ kind, width, height, theme, headerHeight: geometry.height });
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await more().click();
  await menu().getByRole('menuitem', { name: '工具', exact: true }).click();
  await menu().getByRole('menuitem', { name: '群聊侧栏', exact: true }).click();
  await page.locator('.is-mobile-group-info-open > .group-info-panel').waitFor();
  await page.getByRole('button', { name: '关闭群聊侧栏', exact: true }).click();
  await more().click();
  await page.evaluate(() => window.chatHeaderQa.kind('direct'));
  await menu().waitFor({ state: 'detached' });
  await more().focus();
  await page.keyboard.press('ArrowDown');
  await menu().waitFor();
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute('role'))) === 'menuitem',
    '菜单未获得焦点',
  );
  await menu().getByRole('menuitem', { name: '消息', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await menu().getByRole('group', { name: '消息', exact: true }).waitFor();
  assert(
    (await page.evaluate(() => document.activeElement?.textContent)) === '已撤回消息',
    '键盘未进入消息子项',
  );
  await page.keyboard.press('ArrowLeft');
  assert(
    (await menu().getByRole('group', { name: '消息', exact: true }).count()) === 0,
    '键盘未收起子项',
  );
  await page.keyboard.press('End');
  assert(
    (await page.evaluate(() => document.activeElement?.textContent)) === '会话设置',
    '菜单键盘导航失败',
  );
  await page.setViewportSize({ width: 640, height: 320 });
  await page.getByRole('button', { name: '工具', exact: true }).waitFor();
  assert(
    JSON.stringify(
      await page
        .locator('.chat-actions > button')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    ) === JSON.stringify(['搜索', '消息', '工具', '会话设置']),
    '横屏没有使用四个入口',
  );
  assert(
    await page.getByRole('button', { name: '会话设置', exact: true }).isVisible(),
    '桌面设置被移除',
  );
  assert((await more().count()) === 0 && (await menu().count()) === 0, '桌面仍保留手机菜单');
  await page.setViewportSize({ width: 1180, height: 844 });
  await page.evaluate(() => window.chatHeaderQa.kind('group'));
  await page.getByRole('button', { name: '反馈 Bug', exact: true }).waitFor();
  assert(
    (await page.locator('.chat-actions > button').first().getAttribute('aria-label')) ===
      '反馈 Bug',
    '反馈 Bug 未置于最前',
  );
  await page.getByRole('button', { name: '消息', exact: true }).click();
  await page.getByRole('menu', { name: '消息', exact: true }).waitFor();
  if (output && focused) await page.screenshot({ path: resolve(output, 'desktop-messages.png') });
  await page.keyboard.press('Escape');
  const titleBox = () => page.locator('.chat-title-text').boundingBox();
  await page.setViewportSize({ width: 390, height: 844 });
  await more().waitFor();
  const groupTitle = await titleBox();
  await page.evaluate(() => window.chatHeaderQa.showLuckyChar(true));
  const luckyChar = page.locator('img[title^="幸运字符"]');
  await luckyChar.waitFor({ state: 'visible' });
  assert(groupTitle.width > (await titleBox()).width, '有幸运字符时，群名应与徽标共享空间');
  await page.evaluate(() => window.chatHeaderQa.showLuckyChar(false));
  await luckyChar.waitFor({ state: 'detached' });
  assert(Math.abs(groupTitle.width - (await titleBox()).width) <= 1, '无幸运字符时群名应收回空间');
  await page.evaluate(() => {
    window.chatHeaderQa.alignment(true);
    window.chatHeaderQa.statusReady(false);
  });
  for (const width of [390, 510]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate((width) => {
      document.documentElement.dataset.weqLayout = width === 390 ? 'single' : 'split';
    }, width);
    await page.getByText('在线 - 今日天气', { exact: true }).first().waitFor({ state: 'detached' });
    const status = page.locator(width === 390 ? '.chat-status-mobile' : '.chat-status-desktop');
    assert((await status.boundingBox()) === null, '无状态时应收起会话状态栏');
    await page.evaluate(() => window.chatHeaderQa.statusReady(true));
    await page.locator('.chat-title .weq-online-status:visible').waitFor();
    await page.evaluate(() => window.chatHeaderQa.statusReady(false));
    await page.getByText('在线 - 今日天气', { exact: true }).first().waitFor({ state: 'detached' });
    assert((await status.boundingBox()) === null, '状态移除后应释放会话标题栏空间');
  }
  await page.setViewportSize({ width: 1180, height: 844 });
  const account = page.locator('.app-title-bar-user');
  const accountGap = (left, right) =>
    account.evaluate(
      (node, [left, right]) => {
        const a = node.querySelector(left).getBoundingClientRect();
        const b = node.querySelector(right).getBoundingClientRect();
        return b.left - a.right;
      },
      [left, right],
    );
  const compactGap = (gap) => gap >= 0 && gap <= 12;
  assert(
    compactGap(await accountGap('.app-title-bar-nick', '.app-title-bar-signature')),
    '没有会员徽标和状态时，签名应紧随昵称',
  );
  await page.evaluate(() => window.chatHeaderQa.statusReady(true));
  await page.locator('.chat-status-desktop .weq-online-status').waitFor();
  await account.locator('.weq-title-online-status').waitFor();
  assert(
    compactGap(await accountGap('.app-title-bar-nick', '.weq-title-online-status')) &&
      compactGap(await accountGap('.weq-title-online-status', '.app-title-bar-signature')),
    '短状态应按内容占宽，状态两侧不应出现大空隙',
  );
  for (const componentStyle of ['default', 'qqnt']) {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        ({ componentStyle, theme }) => {
          document.documentElement.dataset.componentStyle = componentStyle;
          document.documentElement.dataset.theme = theme;
        },
        { componentStyle, theme },
      );
      const alignment = await page.locator('.chat-title').evaluate((title) => {
        const name = title.querySelector('strong').getBoundingClientRect();
        const status = title.querySelector('.chat-status-desktop > span').getBoundingClientRect();
        return Math.abs(name.y + name.height / 2 - status.y - status.height / 2);
      });
      assert(
        alignment <= 0.5,
        `昵称与状态未居中对齐：${componentStyle}/${theme} 偏差 ${alignment}px`,
      );
      results.push({ componentStyle, theme, centerOffset: alignment });
      if (output && !focused)
        await page.locator('.chat-header').screenshot({
          path: resolve(output, `alignment-${componentStyle}-${theme}.png`),
        });
    }
  }
  assert(errors.length === 0, errors.join('\n'));
  console.log(JSON.stringify({ cases: results.length, results, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
