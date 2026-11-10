import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
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
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/chat-header.html`,
  );
  await page.waitForSelector('.chat-pane');
  const output = process.env.WEQ_HEADER_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  const more = () => page.getByRole('button', { name: '更多会话操作', exact: true });
  const menu = () => page.getByRole('menu', { name: '会话操作', exact: true });
  for (const kind of ['direct', 'group']) {
    await page.evaluate((kind) => window.chatHeaderQa.kind(kind), kind);
    for (const [width, height] of [
      [320, 640],
      [390, 844],
      [760, 430],
      [640, 320],
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
          (await page.locator('.chat-actions > button').count()) === 2,
          '常驻操作应只有搜索和更多',
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
        for (const label of [
          '分析',
          '导出',
          '拉取漫游消息',
          '撤回列表',
          '删除列表',
          '添加本地消息',
          '会话设置',
        ])
          assert(labels.includes(label), `缺少入口：${label}`);
        if (kind === 'group')
          assert(
            labels.includes('群资料') && labels.includes('导出名单') && labels.includes('反馈 Bug'),
            '缺少群入口',
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
        if (output && width === 390)
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
  await menu().getByRole('menuitem', { name: '群资料', exact: true }).click();
  await page.locator('.is-mobile-group-info-open > .group-info-panel').waitFor();
  await page.getByRole('button', { name: '关闭群资料', exact: true }).click();
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
  await page.keyboard.press('End');
  assert(
    (await page.evaluate(() => document.activeElement?.textContent)) === '会话设置',
    '菜单键盘导航失败',
  );
  await page.setViewportSize({ width: 1180, height: 844 });
  await page.getByRole('button', { name: '消息管理', exact: true }).waitFor();
  assert(
    await page.getByRole('button', { name: '会话设置', exact: true }).isVisible(),
    '桌面设置被移除',
  );
  assert((await more().count()) === 0 && (await menu().count()) === 0, '桌面仍保留手机菜单');
  await page.evaluate(() => window.chatHeaderQa.alignment(true));
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
      if (output)
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
