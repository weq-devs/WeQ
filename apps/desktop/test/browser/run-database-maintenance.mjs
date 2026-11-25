import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const stub = resolve(root, 'test/browser/database-maintenance.stub.ts');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-database-maintenance'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/(QqAvatar|Toast|useQQAutoRefresh)$/, replacement: stub },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
  const page = await browser.newPage({
    viewport: { width: 1060, height: 780 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_MAINTENANCE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const capture = async (name) => {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    if (output) await page.screenshot({ path: `${output}/${name}.png` });
  };
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/database-maintenance.html`,
  );
  const tab = (name) => page.getByRole('tab', { name, exact: true });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const release = button('维护中，解除占用');
  await button('开始体检').waitFor();
  assert.equal(await tab('体检结果').isDisabled(), true);
  assert.equal(await tab('开始修复').isDisabled(), true);
  await tab('开始体检').press('End');
  assert.equal(await tab('开始体检').getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => window.maintenanceQa.calls.scan.length), 0);
  const scanDatabases = page.getByRole('region', { name: '选择数据库' });
  const scanControls = page.getByRole('region', { name: '体检设置' });
  await button('取消全选').click();
  assert.equal(await scanDatabases.getByRole('checkbox', { checked: true }).count(), 0);
  assert.equal(await button('开始体检').isDisabled(), true);
  await button('全选').click();
  assert.equal(
    await scanDatabases.getByRole('checkbox', { checked: true }).count(),
    await scanDatabases.getByRole('checkbox').count(),
  );
  await page.getByRole('checkbox', { name: /unsupported.db/ }).uncheck();
  await capture('scan-desktop');
  const scanButtonBounds = await scanControls
    .getByRole('button', { name: '开始体检' })
    .boundingBox();
  await button('开始体检').click();
  await scanControls.getByRole('button', { name: '暂停体检' }).waitFor();
  assert.deepEqual(await button('暂停体检').boundingBox(), scanButtonBounds);
  await scanDatabases.getByText('等待快速体检', { exact: true }).waitFor();
  assert.equal(await page.getByRole('radiogroup', { name: '体检类型' }).count(), 0);
  assert.equal(await tab('体检结果').isDisabled(), true);
  assert.equal(await tab('开始修复').isDisabled(), true);
  assert.equal(await release.count(), 0);
  await page.evaluate(() => window.maintenanceQa.complete());
  const summary = page.getByRole('region', { name: '本轮检查结论' });
  await summary.waitFor();
  assert.equal(await release.getByText('维护中', { exact: true }).isVisible(), true);
  const releaseLabel = release.getByText('解除占用', { exact: true });
  assert.equal(await releaseLabel.isVisible(), false);
  await release.hover();
  await releaseLabel.waitFor();
  await release.click();
  const releaseDialog = page.getByRole('dialog', { name: '解除数据库占用？' });
  await releaseDialog.getByRole('button', { name: '继续维护' }).click();
  assert.equal(await page.evaluate(() => window.maintenanceQa.snapshot().locked), true);
  assert.equal(await tab('体检结果').getAttribute('aria-selected'), 'true');
  await page.getByText('发现 1 个坏页，尚未定位', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: '查看 unsupported.db 检查详情' }).count(), 0);
  const exportButton = summary.getByRole('button', { name: '导出报告' });
  await exportButton.press('Enter');
  const exportMenu = page.getByRole('menu', { name: '导出报告' });
  await exportMenu.getByRole('menuitem', { name: 'HTML' }).waitFor();
  await capture('report-export-desktop');
  await page.keyboard.press('Escape');
  assert.equal(await exportMenu.count(), 0);
  assert.equal(await exportButton.evaluate((element) => element === document.activeElement), true);
  await exportButton.click();
  await exportMenu.getByRole('menuitem', { name: 'JSON' }).click();
  assert.equal(await exportMenu.count(), 0);
  await capture('report-unlocated-desktop');
  await page.setViewportSize({ width: 680, height: 780 });
  await capture('report-unlocated-narrow');
  await page.setViewportSize({ width: 1060, height: 780 });
  await summary.getByRole('button', { name: '进入修复' }).click();
  await page.getByRole('radio', { name: '深度修复', checked: true }).waitFor();
  await page.getByRole('radio', { name: '快速修复' }).click();
  assert.equal(await page.getByRole('checkbox', { name: '修复 nt_msg.db' }).isChecked(), true);
  await page.getByRole('radio', { name: '深度修复' }).click();
  await tab('开始体检').click();
  await button('追加体检').waitFor();
  await capture('scan-after-completion-desktop');
  await tab('体检结果').click();
  await summary.getByRole('button', { name: '追加体检' }).click();
  await page.getByRole('radio', { name: '深度体检' }).click();
  await page.getByRole('checkbox', { name: '体检 profile.db' }).uncheck();
  const queuedDeep = scanDatabases.getByRole('listitem').filter({ hasText: 'nt_msg.db' });
  assert.equal(await queuedDeep.count(), 1);
  await queuedDeep.getByText('等待深度体检', { exact: true }).waitFor();
  await queuedDeep.getByText('快速体检完成 · 发现 1 个坏页，尚未定位').waitFor();
  const appendBounds = await button('开始补充检查').boundingBox();
  await button('开始补充检查').click();
  await scanControls.getByRole('button', { name: '暂停体检' }).waitFor();
  assert.deepEqual(await button('暂停体检').boundingBox(), appendBounds);
  await page.evaluate(() => window.maintenanceQa.structure());
  await page.getByText('检查页结构与引用', { exact: true }).waitFor();
  assert.equal(
    Number(await page.getByRole('progressbar').last().getAttribute('value')),
    (800 / 2048) * 100,
  );
  await capture('scan-progress-desktop');
  await page.evaluate(() => window.maintenanceQa.tableStructure());
  await page.getByText('lookup_12', { exact: true }).waitFor();
  const completedTable = page.getByText('table_11', { exact: true });
  const completedIndex = page.getByText('lookup_11', { exact: true });
  assert.equal(await completedIndex.isVisible(), false);
  await completedTable.locator('..').focus();
  await page.keyboard.press('Enter');
  await completedIndex.waitFor();
  await tab('体检结果').click();
  await button('暂停体检').click();
  await page.getByRole('heading', { name: '体检已暂停' }).waitFor();
  assert.equal(await tab('体检结果').getAttribute('aria-selected'), 'true');
  const resumeBounds = await button('继续体检').boundingBox();
  const repairBounds = await button('前往修复').boundingBox();
  assert.ok(resumeBounds && repairBounds && resumeBounds.x < repairBounds.x);
  assert.equal(await button('导出报告').isVisible(), true);
  await capture('checkup-paused-desktop');
  assert.equal(await page.getByRole('radiogroup', { name: '体检类型' }).count(), 0);
  await button('追加体检').click();
  assert.equal(await tab('开始体检').getAttribute('aria-selected'), 'true');
  await page.getByRole('radio', { name: '快速体检', exact: true }).click();
  await page.getByRole('radio', { name: '深度体检', exact: true }).click();
  await page.getByRole('checkbox', { name: '体检 profile.db' }).check();
  await button('继续体检').click();
  await button('暂停体检').waitFor();
  await page.evaluate(() => window.maintenanceQa.complete());
  await button('进入修复').waitFor();
  assert.equal(await tab('体检结果').getAttribute('aria-selected'), 'true');
  await page.getByText('空闲叶页 · 页 4,663,083', { exact: true }).waitFor();
  await summary.getByRole('button', { name: '追加体检' }).click();
  await page.getByRole('radio', { checked: true, name: '深度体检' }).waitFor();
  await tab('体检结果').click();
  assert.deepEqual(
    await page.evaluate(() =>
      window.maintenanceQa.calls.scan.map(({ kind, dbNames }) => [kind, dbNames]),
    ),
    [
      ['scan', ['nt_msg.db', 'profile.db']],
      ['checkup', ['nt_msg.db']],
      ['checkup', ['nt_msg.db', 'profile.db']],
    ],
  );
  await button('历史报告与恢复').click();
  const historyPane = page.getByRole('dialog', { name: '历史报告与恢复' });
  await historyPane.getByRole('button', { name: '查看结果', exact: true }).first().waitFor();
  await capture('history-overlay-desktop');
  await historyPane.getByRole('button', { name: '查看结果', exact: true }).first().click();
  await historyPane.getByRole('button', { name: 'JSON', exact: true }).click();
  await historyPane.getByRole('button', { name: '关闭', exact: true }).click();
  await button('数据库修复设置').click();
  const settingsPane = page.getByRole('dialog', { name: '数据库修复设置' });
  await settingsPane.getByText('/synthetic/cache', { exact: true }).waitFor();
  await settingsPane.getByRole('button', { name: '关闭', exact: true }).click();
  await button('进入修复').click();
  await page.getByRole('radio', { name: '快速修复' }).click();
  assert.equal(await page.getByRole('checkbox', { name: '保留备份' }).isChecked(), false);
  await capture('quick-plan-desktop');
  await button('开始修复').click();
  await page.getByRole('dialog').getByRole('button', { name: '开始修复' }).click();
  await button('停止修复').waitFor();
  await page.evaluate(() => window.maintenanceQa.failQuick());
  const repairSummary = page.getByRole('region', { name: '本次修复结论' });
  await repairSummary.getByRole('button', { name: '继续修复' }).waitFor();
  assert.equal(await tab('修复结果').getAttribute('aria-selected'), 'true');
  await capture('repair-waiting-desktop');
  await repairSummary.getByRole('button', { name: '继续修复' }).click();
  await page.getByRole('radio', { name: '深度修复', checked: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '保留备份' }).isChecked(), true);
  await page.setViewportSize({ width: 680, height: 780 });
  await page.evaluate(() => {
    window.maintenanceQa.theme.getState().setPreference('dark');
    window.maintenanceQa.theme.getState().setAccent('#91d7ad');
  });
  await capture('deep-plan-narrow-dark');
  await page.evaluate(() => window.maintenanceQa.lowSpace(1_100_000));
  await page.getByRole('checkbox', { name: '仍尝试修复' }).waitFor();
  await capture('repair-space-narrow-dark');
  await page.evaluate(() => window.maintenanceQa.lowSpace(10_000_000_000));
  await button('开始修复').click();
  await page.getByRole('dialog').getByRole('button', { name: '开始修复' }).click();
  await button('停止修复').waitFor();
  await page.evaluate(() => window.maintenanceQa.repair());
  await page.getByText('恢复表数据', { exact: true }).waitFor();
  await capture('repair-progress-narrow-dark');
  await button('停止修复').click();
  await page.waitForFunction(() => window.maintenanceQa.snapshot().locked === false);
  assert.equal(await tab('开始修复').isDisabled(), true);
  assert.equal(await tab('修复结果').getAttribute('aria-selected'), 'true');
  assert.equal(await repairSummary.getByRole('button', { name: '继续修复' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '查看 profile.db 修复详情' }).count(), 0);
  await capture('repair-result-narrow-dark');
  await repairSummary.getByRole('button', { name: '导出报告' }).click();
  await exportMenu.getByRole('menuitem', { name: 'JSON' }).click();
  const exportedRepairId = await page.evaluate(
    () => window.maintenanceQa.calls.export.at(-1)?.reportId,
  );
  assert.equal(
    exportedRepairId,
    await page.evaluate(() => window.maintenanceQa.snapshot().operation.id),
  );
  await tab('体检结果').click();
  await summary.getByRole('button', { name: '导出报告' }).click();
  await exportMenu.getByRole('menuitem', { name: 'JSON' }).click();
  assert.notEqual(
    await page.evaluate(() => window.maintenanceQa.calls.export.at(-1)?.reportId),
    exportedRepairId,
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.maintenanceQa.calls.repair.map((call) => call.methods['nt_msg.db']),
    ),
    ['quick', 'deep'],
  );
  await page.reload();
  await button('取消全选').click();
  await page.getByRole('checkbox', { name: '体检 profile.db' }).check();
  await button('开始体检').click();
  await button('暂停体检').click();
  await page.getByRole('heading', { name: '体检已暂停' }).waitFor();
  assert.equal(await button('前往修复').count(), 0);
  assert.equal(await button('导出报告').count(), 0);
  assert.equal(await page.evaluate(() => window.maintenanceQa.snapshot().locked), false);
  await button('继续体检').click();
  await button('追加体检').click();
  await page.getByRole('checkbox', { name: '体检 unsupported.db' }).check();
  await button('加入本轮体检').click();
  await scanDatabases
    .getByRole('listitem')
    .filter({ hasText: 'unsupported.db' })
    .getByText('等待快速体检', { exact: true })
    .waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.maintenanceQa.calls.append.map(({ dbNames }) => dbNames)),
    [['unsupported.db']],
  );
  assert.equal(await page.evaluate(() => window.maintenanceQa.calls.stop), 1);
  await page.evaluate(() => window.maintenanceQa.complete());
  const unavailable = button('进入修复');
  await unavailable.hover();
  assert.equal(await unavailable.isDisabled(), true);
  await page.getByRole('tooltip').filter({ hasText: '本轮体检未发现需要修复的问题。' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('数据库维护：选择与追加体检、原地暂停、修复提示、报告导出、修复流程和代表布局通过。');
} finally {
  await browser?.close();
  await server.close();
}
