import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const target = process.env.WEQ_STYLE_TARGET ?? 'web';
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-clone-modal'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify(target) },
  plugins: [react(), tailwind()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/clone-modal.stub.ts'),
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const [theme, width, height, style, accent, background] of [
    ['dark', 1280, 800, 'qqnt', '#73cab8', 'grid'],
    ['light', 1280, 800, 'qqnt', '#075c30', 'plain'],
    ['dark', 390, 844, 'classic', '#fff3a1', 'dots'],
    ['light', 390, 844, 'classic', '#b73172', 'paper'],
    ['system', 844, 390, 'retro', '#73cab8', 'grid'],
    ['dark', 320, 568, 'qqnt', '#fff3a1', 'plain'],
  ]) {
    const profile = `${target}-${theme}-${width}-${height}-${style}`;
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    const open = async (query = '') => {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/clone-modal.html?${query}`,
      );
      await page.evaluate(
        ([theme, style, accent, background]) =>
          window.cloneModalTheme.setState({
            preference: theme,
            componentStyle: style,
            accent,
            background,
          }),
        [theme, style, accent, background],
      );
      // 主题 store 的 setter 同时更新实际 DOM token，不能仅修改 store 状态。
      await page.evaluate(() => {
        const theme = window.cloneModalTheme.getState();
        theme.setPreference(theme.preference);
        theme.setComponentStyle(theme.componentStyle);
        theme.setAccent(theme.accent);
        theme.setBackground(theme.background);
      });
      await page.locator('.weq-clone-modal-head').waitFor();
    };
    const check = async (state, scrollSelector) => {
      const layout = await page.locator('.weq-clone-modal').evaluate((node, scrollSelector) => {
        const rect = node.closest('.weq-modal').getBoundingClientRect();
        const head = node.querySelector('header').getBoundingClientRect();
        const footer = node.querySelector('.weq-clone-actions').getBoundingClientRect();
        const buttons = [...node.querySelector('.weq-clone-actions').querySelectorAll('button')];
        const scroll = node.querySelector(scrollSelector);
        const content = scroll.getBoundingClientRect();
        return {
          fits:
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight,
          footerVisible: footer.top >= head.bottom && footer.bottom <= rect.bottom,
          rightGap: rect.right - buttons.at(-1).getBoundingClientRect().right,
          bottomGap:
            rect.bottom -
            Math.max(...buttons.map((button) => button.getBoundingClientRect().bottom)),
          contentSeparate: content.top >= head.bottom - 1 && content.bottom <= footer.top + 1,
          overflow: [...node.querySelectorAll('*')]
            .filter((item) => {
              const css = getComputedStyle(item);
              return (
                item.clientWidth &&
                item.scrollWidth > item.clientWidth + 1 &&
                css.overflowX === 'visible'
              );
            })
            .map((item) => item.className),
          scrollable: scroll.scrollHeight > scroll.clientHeight,
          footerY: footer.y,
        };
      }, scrollSelector);
      assert.ok(layout.fits, `${profile}/${state}: 浮窗越界`);
      assert.ok(layout.footerVisible, `${profile}/${state}: 操作区不可见`);
      assert.ok(layout.rightGap >= 12, `${profile}/${state}: 右侧间距 ${layout.rightGap}`);
      assert.ok(layout.bottomGap >= 12, `${profile}/${state}: 底部间距 ${layout.bottomGap}`);
      assert.ok(layout.contentSeparate, `${profile}/${state}: 内容与操作区重叠`);
      assert.deepEqual(layout.overflow, [], `${profile}/${state}: 内容横向溢出`);
      await page.locator(scrollSelector).evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      const footerY = await page
        .locator('.weq-clone-actions')
        .evaluate((node) => node.getBoundingClientRect().y);
      assert.equal(footerY, layout.footerY, `${profile}/${state}: 操作区随内容滚动`);
      if (output) {
        await page.locator(scrollSelector).evaluate((node) => {
          node.scrollTop = 0;
        });
        await page.screenshot({ path: resolve(output, `${profile}-${state}.png`) });
      }
      return layout;
    };
    await open();
    assert.ok((await check('picker', '.weq-exp-list')).scrollable);
    await page.getByPlaceholder('搜索好友昵称 / QQ 号').fill('无匹配结果');
    await page.getByText('没有匹配的好友', { exact: true }).waitFor();
    await check('no-match', '.weq-exp-list');
    await page.getByPlaceholder('搜索好友昵称 / QQ 号').fill('10002');
    await page.locator('.weq-exp-row').click();
    await page.getByRole('button', { name: /下一步/ }).click();
    await check('config', '.weq-clone-config');
    await page.getByRole('button', { name: '返回选择好友', exact: true }).click();
    assert.equal(await page.locator('.weq-exp-row[aria-pressed="true"]').count(), 1);
    await page.getByRole('button', { name: /下一步/ }).click();
    await page.getByRole('button', { name: '开始克隆', exact: true }).click();
    assert.equal(await page.locator('output').textContent(), '很长的好友名称'.repeat(12));
    await open('group');
    await check('group', '.weq-clone-config');
    await page.getByPlaceholder('给这个群起个名字').fill('合成群');
    await page.locator('.weq-exp-row').nth(0).click();
    await page.locator('.weq-exp-row').nth(1).click();
    await page.getByRole('button', { name: '创建群聊', exact: true }).click();
    assert.deepEqual(JSON.parse(await page.locator('output').textContent()), {
      name: '合成群',
      personaIds: ['u_synthetic_0', 'u_synthetic_1'],
    });
    await open('empty');
    await page.getByText('没有可克隆的好友', { exact: true }).waitFor();
    await check('empty', '.weq-exp-list');
    assert.ok(await page.getByRole('button', { name: '下一步', exact: true }).isDisabled());
    await page.keyboard.press('Escape');
    await page.locator('.weq-clone-modal').waitFor({ state: 'hidden' });
    results.push({ profile, passed: true });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
