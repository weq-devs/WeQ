import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  cacheDir: resolve(root, 'node_modules/.vite-task-cleanup'),
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/completed-task-cleanup.stub.ts'),
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
  browser = await (process.env.WEQ_BROWSER_ENGINE === 'webkit' ? webkit : chromium).launch({
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
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/completed-task-cleanup.html`,
  );
  if (output) await mkdir(output, { recursive: true });
  for (const [dark, width, height, accent] of [
    [false, 1000, 800, '#075c30'],
    [true, 1000, 800, '#fff3a1'],
    [false, 360, 640, '#b53358'],
    [true, 360, 420, '#73cab8'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(([dark, accent]) => window.cleanupTheme(dark, accent), [dark, accent]);
    await page.getByRole('button', { name: '打开任务菜单', exact: true }).click();
    const menu = page.locator('.weq-workspace-menu');
    const heights = [];
    for (const count of [0, 1, 24]) {
      await page.evaluate((count) => window.cleanupMenuTasks(count), count);
      await menu.getByText(`${count} 项任务`, { exact: false }).waitFor();
      const bounds = await menu.boundingBox();
      heights.push(bounds.height);
      assert.ok(bounds.height <= Math.min(560, height - 32) + 1, '菜单只限制最大高度');
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height + 1, '菜单不超出视口');
      const expand = menu.getByRole('button', { name: '打开完整任务面板', exact: true });
      const summary = await menu.locator('.weq-current-tasks-summary > span').boundingBox();
      const expandBounds = await expand.boundingBox();
      assert.ok(expandBounds.x >= summary.x + summary.width, '展开按钮紧邻数量右侧');
      assert.ok(
        Math.abs(expandBounds.y + expandBounds.height / 2 - summary.y - summary.height / 2) < 2,
        '展开按钮与数量垂直居中',
      );
      assert.equal(
        await menu.locator('.weq-workspace-menu-head').count(),
        0,
        '紧凑列表没有重复标题',
      );
      if (count === 0) {
        assert.equal(await menu.locator('.weq-empty-state svg').count(), 1);
        assert.equal(await menu.getByText('请选择任务', { exact: true }).count(), 0);
        const empty = await menu.locator('.weq-empty-state').boundingBox();
        assert.ok(
          Math.abs(empty.x + empty.width / 2 - bounds.x - bounds.width / 2) < 2,
          '空态居中',
        );
      }
      if (count === 24) {
        const scrolling = await menu.locator('.weq-current-tasks').evaluate((element) => ({
          client: element.clientHeight,
          scroll: element.scrollHeight,
          overflow: getComputedStyle(element).overflowY,
        }));
        assert.ok(scrolling.scroll > scrolling.client, '多任务滚动而不是撑高菜单');
        assert.equal(scrolling.overflow, 'auto');
        assert.ok(await menu.locator('.weq-workspace-actions').isVisible(), '底部工具保持可见');
      }
      if (output)
        await page.screenshot({
          path: resolve(
            output,
            `task-menu-${dark ? 'dark' : 'light'}-${width}-${height}-${count}.png`,
          ),
        });
    }
    assert.ok(heights[0] < 360, '空菜单不再固定占满 560px');
    assert.ok(heights[1] < heights[0], '一条任务按实际内容收缩');
    assert.ok(heights[2] > heights[1], '任务增加时菜单自然增高');
    await page.evaluate(() => window.cleanupMenuTasks(0));
    await menu.getByText('暂无任务', { exact: true }).waitFor();
    await menu.getByRole('button', { name: '打开完整任务面板', exact: true }).click();
    assert.equal(
      await menu.getByText('请选择任务', { exact: true }).count(),
      0,
      '空完整面板不显示第二个空态',
    );
    await page.keyboard.press('Escape');
    // 再次点击同一入口收起，保留其余清理回归的紧凑布局。
    await page.getByRole('button', { name: '打开任务菜单', exact: true }).click();
    await menu.getByRole('button', { name: '打开完整任务面板', exact: true }).click();
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => window.cleanupMenuTasks(2));
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.getByRole('button', { name: '打开任务菜单', exact: true }).click();
  // 保留真实入场动画，等待其完成后检查可见性和命中层级。
  await page
    .locator('.weq-workspace-menu')
    .getByRole('button', { name: '清理已结束任务', exact: true })
    .click();
  const menuDialog = page.getByRole('dialog', { name: '清理已结束任务', exact: true });
  await page.waitForFunction(
    () => {
      const dialog = document.querySelector('.weq-message-modal');
      return (
        dialog &&
        getComputedStyle(dialog).opacity === '1' &&
        getComputedStyle(dialog.parentElement).opacity === '1'
      );
    },
    undefined,
    { timeout: 3000 },
  );
  assert.deepEqual(
    await menuDialog.evaluate((element) => ({
      opacity: getComputedStyle(element).opacity,
      layerOpacity: getComputedStyle(element.parentElement).opacity,
    })),
    { opacity: '1', layerOpacity: '1' },
  );
  assert.equal(
    await menuDialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
      );
    }),
    true,
    '确认框必须位于任务菜单之上',
  );
  if (output) await page.screenshot({ path: resolve(output, 'task-cleanup-menu-visible.png') });
  await menuDialog.getByRole('button', { name: '保留', exact: true }).click({ timeout: 3000 });
  await page.keyboard.press('Escape');
  for (const [dark, width, accent] of [
    [false, 1000, '#075c30'],
    [true, 1000, '#fff3a1'],
    [false, 360, '#ffffff'],
    [true, 360, '#73cab8'],
  ]) {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(([dark, accent]) => window.cleanupTheme(dark, accent), [dark, accent]);
    const cleanupButton = page.getByRole('button', { name: '清理已结束任务', exact: true });
    assert.equal((await cleanupButton.innerText()).trim(), '清理已结束任务');
    assert.equal(await cleanupButton.locator('svg').count(), 1);
    assert.equal(await page.getByRole('button', { name: '全部保存', exact: true }).count(), 0);
    if (output)
      await page.screenshot({
        path: resolve(output, `task-toolbar-${dark ? 'dark' : 'light'}-${width}.png`),
      });
    await page.getByRole('button', { name: '清理已结束任务', exact: true }).click();
    await page.getByText('确定清除 3 项已结束任务？', { exact: false }).waitFor();
    await page.getByText('其中 2 项导出尚未保存', { exact: false }).waitFor();
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('button,[role="dialog"]')].some((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left < 0 ||
          rect.right > innerWidth + 1 ||
          element.scrollWidth > element.clientWidth + 1
        );
      }),
    );
    if (overflow) throw new Error(`控件溢出: ${dark}/${width}`);
    if (output)
      await page.screenshot({
        path: resolve(output, `task-cleanup-${dark ? 'dark' : 'light'}-${width}.png`),
      });
    await page.getByRole('button', { name: '保留', exact: true }).click();
    await page
      .getByRole('button', { name: '清理已结束任务', exact: true })
      .waitFor({ state: 'visible' });
    for (const name of ['信息提示', '错误提示']) {
      // 真实点击右下角入口，验证提示不沿用触发点，也不退回靠右浮层布局。
      await page.getByRole('button', { name, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      const bounds = await dialog.boundingBox();
      assert.ok(Math.abs(bounds.x + bounds.width / 2 - width / 2) <= 1, '提示水平居中');
      assert.ok(Math.abs(bounds.y + bounds.height / 2 - 400) <= 1, '提示垂直居中');
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, '窄屏提示不溢出');
      assert.equal(await dialog.getAttribute('aria-modal'), null, '信息提示保持非模态');
      if (output)
        await page.screenshot({
          path: resolve(output, `task-cleanup-${name}-${dark ? 'dark' : 'light'}-${width}.png`),
        });
      await page.getByRole('button', { name: '我知道了', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.getByRole('button', { name, exact: true }).click();
      await dialog.waitFor();
      await page.mouse.click(4, 400);
      await dialog.waitFor({ state: 'detached' });
    }
    await cleanupButton.click();
    await page.getByRole('button', { name: '清除 3 项', exact: true }).click();
    const banner = page.getByRole('status').filter({ hasText: '已清除 3 项任务。' });
    await banner.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const banner = document.querySelector('.weq-toast.show');
      return banner && getComputedStyle(banner).transform === 'matrix(1, 0, 0, 1, 0, 0)';
    });
    assert.equal(await page.getByRole('dialog').count(), 0, '清理成功不再弹窗');
    const bounds = await banner.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, '完成横幅不溢出');
    if (output)
      await page.screenshot({
        path: resolve(output, `task-cleanup-success-${dark ? 'dark' : 'light'}-${width}.png`),
      });
    await page.mouse.move(0, 0);
    await banner.waitFor({ state: 'detached', timeout: 15000 });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    '任务菜单：4 组深浅主题、主题色、桌面/窄屏/矮窗口的空态、内容高度、24 项任务滚动及展开检查通过；任务清除确认框、错误提示及成功横幅回归通过',
  );
} finally {
  await browser?.close();
  await server.close();
}
