import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  cacheDir: resolve(root, 'node_modules/.vite-task-highlight'),
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/task-quick-actions.stub.ts'),
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
let page;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/background-tasks.html`;
  const background = (row) => row.evaluate((element) => getComputedStyle(element).backgroundColor);
  for (const layout of ['compact', 'split']) {
    await page.goto(`${url}${layout === 'compact' ? '?compact' : ''}`);
    await page.locator('.weq-long-task').first().waitFor();
    for (const [dark, width, accent, backdrop] of [
      [false, 1100, '#075c30', 'plain'],
      [true, 1100, '#fff3a1', 'paper'],
      [false, 360, '#a82e68', 'grid'],
      [true, 360, '#73cab8', 'telegram'],
    ]) {
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(
        ([dark, accent, backdrop]) => window.backgroundTheme(dark, accent, backdrop),
        [dark, accent, backdrop],
      );
      await page.mouse.move(0, 0);
      const selected = page.locator('.weq-long-task.is-selected').first();
      const selectedSurface =
        layout === 'compact' ? page.locator('.weq-long-task-entry').first() : selected;
      const target = page
        .locator(
          layout === 'compact'
            ? '.weq-long-task-entry > .weq-long-task:not(.is-selected)'
            : '.weq-long-task:not(.is-selected)',
        )
        .first();
      const targetSurface = layout === 'compact' ? target.locator('..') : target;
      const idleColor = await background(targetSurface);
      const selectedColor = await background(selectedSurface);
      await target.hover();
      const hoverColor = await background(targetSurface);
      if (output)
        await page.screenshot({
          path: resolve(output, `task-highlight-${layout}-${dark ? 'dark' : 'light'}-${width}.png`),
        });
      assert.notEqual(selectedColor, idleColor, '选中高亮覆盖整个任务容器');
      assert.notEqual(hoverColor, idleColor, '悬停高亮覆盖整个任务容器');
      assert.notEqual(hoverColor, selectedColor, '悬停与选中使用不同颜色');
      if (layout === 'compact')
        assert.equal(await background(target), 'rgba(0, 0, 0, 0)', '菜单悬停不局部覆盖任务底色');
      await selected.hover();
      assert.equal(await background(selectedSurface), selectedColor, '悬停不覆盖选中颜色');
      if (layout === 'compact') {
        assert.equal(await background(selected), 'rgba(0, 0, 0, 0)', '内部按钮不重复叠加高亮');
        const action = selectedSurface.locator('.weq-task-quick-actions > button').first();
        await action.hover();
        assert.equal(await background(selectedSurface), selectedColor, '操作栏保持整行选中高亮');
        const targetActions = targetSurface.locator('.weq-task-quick-actions');
        await targetActions.hover();
        assert.equal(await background(targetSurface), hoverColor, '操作栏触发整行悬停高亮');
      }
      await selected.focus();
      assert.equal(
        await selected.evaluate((element) => getComputedStyle(element).outlineStyle),
        'solid',
        '键盘焦点保持可见',
      );
      assert.equal(
        await page.locator('.weq-current-task-list').evaluate((element) =>
          [...element.querySelectorAll('.weq-long-task,.weq-long-task-entry')].some((row) => {
            const bounds = row.getBoundingClientRect();
            const listBounds = element.getBoundingClientRect();
            return bounds.right > listBounds.right + 1 || row.scrollWidth > row.clientWidth + 1;
          }),
        ),
        false,
        '长任务内容不溢出高亮区域',
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log('任务整行高亮：紧凑/分栏、深浅主题、主题色、背景和宽窄屏 8 组检查通过');
} catch (error) {
  if (output && page)
    await page.screenshot({ path: resolve(output, 'task-highlight-failure.png') });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
