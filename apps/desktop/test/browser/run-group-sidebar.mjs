import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_GROUP_SIDEBAR_ARTIFACTS ?? '/tmp/weq-qa/shots/group-sidebar';
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-group-sidebar'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-sidebar.stub.ts'),
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
const report = { shots: [], metrics: {}, errors: [] };
let browser;
const shot = async (page, name) => {
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path });
  report.shots.push(path);
};
const setTheme = async (page, theme) => {
  await page.evaluate((value) => {
    window.groupSidebarQa.theme.getState().setPreference(value);
    window.groupSidebarQa.theme.getState().setAccent(value === 'light' ? '#075c30' : '#fff3a1');
    window.groupSidebarQa.theme.getState().setBackground(value === 'light' ? 'paper' : 'grid');
  }, theme);
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
};
const metrics = (page) =>
  page.evaluate(() => {
    const panel = document.querySelector('.group-info-panel');
    const list = panel.querySelector('.group-info-member-list');
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const summaries = [...panel.querySelectorAll(':scope > .weq-group-summary')].map(box);
    return {
      panel: box(panel),
      list: box(list),
      summaries,
      memberRatio: list.clientHeight / panel.clientHeight,
      memberRows: list.querySelectorAll('.group-info-member-row').length,
      overview: Boolean(panel.querySelector('.group-info-overview')),
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth,
    };
  });
const checkLayout = async (page, name) => {
  const result = await metrics(page);
  assert.equal(result.overview, false, `${name}: sidebar still contains group overview`);
  assert.equal(result.memberRows, 300, `${name}: expected complete member fixture`);
  assert.equal(result.summaries.length, 2, `${name}: expected announcement and todo summaries`);
  assert.ok(result.memberRatio >= 0.65, `${name}: member ratio ${result.memberRatio} < 0.65`);
  assert.ok(result.docScrollWidth <= result.innerWidth, `${name}: horizontal document overflow`);
  for (const summary of result.summaries)
    assert.ok(summary.height <= 36, `${name}: summary grew to ${summary.height}px`);
  assert.ok(result.list.width <= result.panel.width, `${name}: member list escaped rail`);
  report.metrics[name] = result;
  await shot(page, name);
};
const popover = (page) => page.locator('.weq-group-feature-layer');
const checkPopoverFits = async (page, name) => {
  const rect = await popover(page).evaluate((element) => {
    const bounds = element.firstElementChild.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      width: bounds.width,
      innerWidth,
      innerHeight,
    };
  });
  assert.ok(rect.left >= 0 && rect.top >= 0, `${name}: popover escaped top/left`);
  assert.ok(rect.right <= rect.innerWidth, `${name}: popover escaped right`);
  assert.ok(rect.bottom <= rect.innerHeight, `${name}: popover escaped bottom`);
  report.metrics[name] = rect;
};
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page
    .context()
    .route('**/*', (route) =>
      ['127.0.0.1'].includes(new URL(route.request().url()).hostname) ||
      route.request().url().startsWith('data:')
        ? route.continue()
        : route.abort(),
    );
  const base = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-sidebar.html`;
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto(base);
  await page.getByRole('button', { name: '查看群待办', exact: true }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector('.weq-todo-summary')?.textContent?.includes('周五交作业'),
  );
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    for (const [width, height] of [
      [1180, 900],
      [1180, 640],
      [390, 860],
      [390, 640],
      [320, 780],
      [320, 640],
    ]) {
      await page.setViewportSize({ width, height });
      await checkLayout(page, `sidebar-${width}x${height}-${theme}`);
    }
  }
  await setTheme(page, 'light');
  await page.setViewportSize({ width: 1180, height: 900 });
  const initialCalls = await page.evaluate(() => window.groupAuditCalls);
  assert.ok(!initialCalls.includes('account.contactMetrics.snapshot'), 'sidebar queried metrics');
  assert.ok(!initialCalls.includes('account.listGroupAlbums'), 'sidebar preloaded albums');
  assert.ok(!initialCalls.includes('account.listGroupFiles'), 'sidebar preloaded files');
  assert.ok(!initialCalls.includes('account.qqActions.groupReadTools'), 'sidebar preloaded sign');
  await page.getByRole('button', { name: '更多成员操作', exact: true }).click();
  await page.getByRole('menuitem', { name: /已退群/ }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0, 'member menu did not close on Escape');
  await page.getByRole('textbox', { name: '搜索群成员' }).fill('10003');
  await page.waitForFunction(
    () => document.querySelectorAll('.group-info-member-row').length === 1,
  );
  await page.locator('.group-info-member-row').click();
  await page.waitForFunction(
    () => document.querySelector('output')?.getAttribute('data-opened-member') === 'u_member3',
  );
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.group-info-member-row').length === 300,
  );
  await page.locator('.group-info-member-list').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForFunction(
    () => Number(document.querySelector('output')?.getAttribute('data-member-loads')) > 0,
  );
  await page.locator('.group-info-member-list').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole('button', { name: '打卡', exact: true }).click();
  await popover(page).waitFor();
  await page.getByLabel('打卡日期', { exact: true }).waitFor();
  await checkPopoverFits(page, 'sign-popover');
  await shot(page, 'sign-popover-light');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('output')?.getAttribute('data-chat-clicks') === '1',
  );
  assert.equal(await popover(page).count(), 0, 'outside click did not close popover');
  await page.getByRole('button', { name: '精华', exact: true }).click();
  await popover(page).waitFor();
  await page.getByTitle('跳转到消息', { exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('output')?.getAttribute('data-jumped') === '815',
  );
  assert.equal(await popover(page).count(), 0, 'essence jump did not close popover');
  await page.getByRole('button', { name: '查看群待办', exact: true }).click();
  await popover(page).waitFor();
  await page.getByRole('button', { name: '待办操作 816', exact: true }).click();
  await page.getByRole('menu', { name: '待办操作', exact: true }).waitFor();
  assert.equal(await popover(page).count(), 1, 'nested menu closed todo popover');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu', { name: '待办操作', exact: true }).count(), 0);
  assert.equal(await popover(page).count(), 1, 'Escape closed parent with child menu');
  await shot(page, 'todo-popover-light');
  await page.getByRole('button', { name: '打卡', exact: true }).click();
  await page.getByLabel('打卡日期', { exact: true }).waitFor();
  assert.equal(await popover(page).count(), 1, 'entry switch opened multiple popovers');
  await page.keyboard.press('Escape');
  assert.equal(await popover(page).count(), 0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 780 });
    await page.getByRole('button', { name: '精华', exact: true }).click();
    await popover(page).waitFor();
    await checkPopoverFits(page, `essence-popover-${width}`);
    await shot(page, `essence-popover-${width}`);
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1180, height: 900 });
  const [firstAlbum] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: '相册', exact: true }).click(),
  ]);
  firstAlbum.on('pageerror', (error) => report.errors.push(error.message));
  await firstAlbum.locator('.group-album-dialog').waitFor();
  await firstAlbum.waitForFunction(() => document.title.includes('原来的群名称'));
  const albumWindowCount = page.context().pages().length;
  await page.getByRole('button', { name: '相册', exact: true }).click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    page.context().pages().length,
    albumWindowCount,
    'same group opened duplicate window',
  );
  await page.evaluate(() => window.groupSidebarQa.setGroup('54321'));
  await page.locator('.qa-chat-header').filter({ hasText: '另一个群' }).waitFor();
  assert.ok((await firstAlbum.title()).includes('原来的群名称'), 'chat switch changed open album');
  const [secondAlbum] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: '相册', exact: true }).click(),
  ]);
  secondAlbum.on('pageerror', (error) => report.errors.push(error.message));
  await secondAlbum.locator('.group-album-dialog').waitFor();
  await secondAlbum.waitForFunction(() => document.title.includes('另一个群'));
  assert.equal(
    page.context().pages().length,
    albumWindowCount + 1,
    'cross-group album not independent',
  );
  const [files] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: '文件', exact: true }).click(),
  ]);
  files.on('pageerror', (error) => report.errors.push(error.message));
  await files.locator('.group-file-dialog').waitFor();
  await files.bringToFront();
  await files.locator('.weq-file-manager-status').click({ button: 'right' });
  await files.getByRole('menu', { name: '群文件操作', exact: true }).waitFor();
  assert.equal(await page.getByRole('menu', { name: '群文件操作', exact: true }).count(), 0);
  await files.keyboard.press('Escape');
  await files.getByRole('menu', { name: '群文件操作', exact: true }).waitFor({ state: 'hidden' });
  await setTheme(page, 'dark');
  await files.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  const fileShot = resolve(output, 'files-system-window-dark.png');
  await files.screenshot({ path: fileShot });
  report.shots.push(fileShot);
  const albumShot = resolve(output, 'albums-system-window-dark.png');
  await secondAlbum.screenshot({ path: albumShot });
  report.shots.push(albumShot);
  await firstAlbum.close();
  assert.equal(secondAlbum.isClosed(), false, 'closing one album closed another group');
  const secondAlbumClosed = secondAlbum.waitForEvent('close');
  const filesClosed = files.waitForEvent('close');
  await page.evaluate(() => window.groupSidebarQa.setOwner('99999:another-source'));
  await Promise.all([secondAlbumClosed, filesClosed]);
  report.metrics.resourceWindows = {
    duplicateReused: true,
    crossGroupIndependent: true,
    themeSynchronized: true,
    sourceChangeReleased: true,
    childDocumentMenu: true,
  };
  await page.setViewportSize({ width: 1180, height: 640 });
  const readySummaries = (await metrics(page)).summaries;
  await page.evaluate(() => {
    window.groupSidebarQa.setMode('error');
    window.groupSidebarQa.setError('成员读取失败，用于确认错误不挤压顶部摘要');
  });
  await page.waitForFunction(() =>
    document.querySelector('.group-info-member-error')?.textContent?.includes('成员读取失败'),
  );
  await checkLayout(page, 'sidebar-errors-1180x640');
  assert.deepEqual((await metrics(page)).summaries, readySummaries, 'error changed summary height');
  assert.deepEqual(report.errors, [], 'browser emitted runtime errors');
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ shots: report.shots.length, errors: report.errors }));
  console.log(JSON.stringify(report.metrics, null, 1));
} finally {
  await browser?.close();
  await server.close();
}
