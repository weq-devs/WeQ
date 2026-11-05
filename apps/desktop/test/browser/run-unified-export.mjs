import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cache = await mkdtemp(resolve(root, 'node_modules/.cache/unified-export-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: cache,
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/extra-export.stub.ts'),
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
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const output = process.env.WEQ_REPORT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [width, theme, accent, background] of [
    [1280, 'light', '#14652d', 'plain'],
    [1280, 'dark', '#ffe8a6', 'grid'],
    [390, 'light', '#d73758', 'paper'],
    [390, 'dark', '#72c9bf', 'telegram'],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/unified-export.html`,
    );
    await page.evaluate(
      ({ theme, accent, background }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.background = background;
        document.documentElement.style.setProperty('--weq-accent-effective', accent);
      },
      { theme, accent, background },
    );
    const start = page.getByRole('button', { name: '开始导出', exact: true });
    await start.waitFor();
    if (!(await start.isDisabled())) throw new Error('格式空选未禁用开始');
    await page.getByText('请至少选择一种导出格式', { exact: true }).waitFor();
    await page
      .getByRole('radiogroup', { name: '图片导出方式', exact: true })
      .getByRole('radio', { name: '仅本地', exact: true })
      .click();
    await page.getByRole('button', { name: '不添加 JSON', exact: true }).click();
    if (await start.isDisabled()) throw new Error('仅媒体模式仍要求选择格式');
    if (
      (await page
        .locator('.weq-exp-format')
        .filter({ hasText: /^JSON$/ })
        .getAttribute('aria-pressed')) !== 'false'
    )
      throw new Error('取消后暗中选中了 JSON');
    await start.click();
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-testid="export-result"]').textContent;
      return text && JSON.parse(text).formats.length === 0;
    });
    await page
      .getByRole('radiogroup', { name: '全部导出方式', exact: true })
      .getByRole('radio', { name: '不导出', exact: true })
      .click();
    await page.getByRole('button', { name: '展开图片明细', exact: true }).click();
    await page
      .getByRole('radiogroup', { name: '图片：资源详细信息', exact: true })
      .getByRole('radio', { name: '仅本地', exact: true })
      .click();
    await page.getByRole('button', { name: '选中 JSON', exact: true }).click();
    if (
      (await page
        .locator('.weq-exp-format')
        .filter({ hasText: /^JSON$/ })
        .getAttribute('aria-pressed')) !== 'true'
    )
      throw new Error('同意后未选中 JSON');
    const groups = await page
      .locator('.weq-export-content-selector [role="radiogroup"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
    if (groups[1] !== '消息导出方式' || groups.at(-1) !== '联系人或群资料导出方式')
      throw new Error('附加数据或独立资料项目位置错误');
    const additional = page.getByRole('button', { name: '导出附加数据（仅本地）', exact: true });
    const all = page.getByRole('radiogroup', { name: '全部导出方式', exact: true });
    await all.getByRole('radio', { name: '仅本地', exact: true }).click();
    if ((await additional.getAttribute('aria-pressed')) !== 'true')
      throw new Error('附加数据全选后按钮未亮起');
    await additional.click();
    if ((await additional.getAttribute('aria-pressed')) !== 'false')
      throw new Error('附加数据关闭后按钮未熄灭');
    if (
      (await all
        .getByRole('radio', { name: '仅本地', exact: true })
        .getAttribute('aria-checked')) !== 'true'
    )
      throw new Error('关闭附加数据清除了全部状态');
    const underDivider = await additional.evaluate((node) => {
      const row = node.closest('.is-detail');
      const group = node.closest('.weq-export-content-group');
      return Boolean(
        row &&
          group &&
          Number.parseFloat(getComputedStyle(group).borderBottomWidth) > 0 &&
          !row.querySelector('svg'),
      );
    });
    if (!underDivider) throw new Error('附加数据未作为分割线上方的明细子项');
    await all.getByRole('radio', { name: '不导出', exact: true }).click();
    await additional.click();
    if (await start.isDisabled()) throw new Error('附加数据独立总控未生效');
    await additional.click();
    await page
      .getByRole('radiogroup', { name: '图片：资源详细信息', exact: true })
      .getByRole('radio', { name: '仅本地', exact: true })
      .click();
    if (await start.isDisabled()) throw new Error('独立明细未启用开始');
    if (
      (await page
        .getByRole('radiogroup', { name: '图片：资源详细信息', exact: true })
        .getByRole('radio')
        .count()) !== 2
    )
      throw new Error('明细云端段未隐藏');
    if (
      (await page
        .getByRole('radiogroup', { name: 'QQ表情导出方式', exact: true })
        .getByRole('radio')
        .count()) !== 2
    )
      throw new Error('QQ表情云端段未隐藏');
    const aligned = await page.evaluate(() => {
      const groups = [
        ...document.querySelectorAll('.weq-export-content-selector [role="radiogroup"]'),
      ];
      const positions = groups.map((group) =>
        [...group.querySelectorAll('button')]
          .slice(0, 2)
          .map((button) => button.getBoundingClientRect().left),
      );
      return positions.every((row) =>
        row.every((x, index) => Math.abs(x - positions[0][index]) < 1),
      );
    });
    if (!aligned) throw new Error('前两段未对齐');
    const day = page.getByRole('button', { name: '2026-11-12，消息数量统计中', exact: true });
    await day.click();
    await page.getByRole('button', { name: '完成统计', exact: true }).click();
    if ((await page.locator('output').textContent()) !== '2026-11-12')
      throw new Error('统计中日期未选中');
    if (
      (await page.getByRole('combobox', { name: '年份', exact: true }).first().inputValue()) !==
      '2026'
    )
      throw new Error('完成统计后抢走用户月份');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error(`水平溢出 ${width}/${theme}`);
    if (output)
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), fullPage: true });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    '4 种主题、宽度、主题色和背景组合通过：空选理由、独立明细、隐藏段对齐、统计中选日期、布局。',
  );
} finally {
  await browser?.close();
  await server.close();
  await rm(cache, { recursive: true, force: true });
}
