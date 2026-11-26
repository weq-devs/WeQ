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
  // 归档可恢复，执行后直接从当前列表移走。
  const menu = page.locator('.weq-workspace-menu');
  await menu.getByRole('button', { name: '归档已结束任务', exact: true }).click();
  await menu.getByText('1 项任务', { exact: false }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '查看归档示例' }).click();
  const archived = page.getByLabel('已归档任务列表', { exact: true });
  await archived.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '彻底删除' }).click();
  const confirmDeletion = page.getByRole('dialog', { name: '彻底删除任务？' });
  await confirmDeletion.getByText(/删除后将无法从任务列表取回/).waitFor();
  await confirmDeletion.getByRole('button', { name: '保留', exact: true }).click();
  for (const [dark, width, accent] of [
    [false, 1000, '#075c30'],
    [true, 1000, '#fff3a1'],
    [false, 360, '#ffffff'],
    [true, 360, '#73cab8'],
  ]) {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(([dark, accent]) => window.cleanupTheme(dark, accent), [dark, accent]);
    const cleanupButton = page.getByRole('button', { name: '归档已结束任务', exact: true });
    assert.equal((await cleanupButton.innerText()).trim(), '归档已结束任务');
    assert.equal(await cleanupButton.locator('svg').count(), 1);
    assert.equal(await page.getByRole('button', { name: '全部保存', exact: true }).count(), 0);
    if (output)
      await page.screenshot({
        path: resolve(output, `task-toolbar-${dark ? 'dark' : 'light'}-${width}.png`),
      });
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
    await page
      .getByRole('button', { name: '归档已结束任务', exact: true })
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
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    '任务菜单：4 组深浅主题、主题色、桌面/窄屏/矮窗口的空态、内容高度、24 项任务滚动及展开检查通过；任务归档、彻底删除确认及错误提示回归通过',
  );
} finally {
  await browser?.close();
  await server.close();
}
