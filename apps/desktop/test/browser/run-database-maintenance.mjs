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
  await button('开始扫描').waitFor();
  assert.equal(await tab('报告').isDisabled(), true);
  assert.equal(await tab('修复').isDisabled(), true);
  await tab('扫描').press('End');
  assert.equal(await tab('扫描').getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => window.maintenanceQa.calls.scan.length), 0);
  const scanDatabases = page.getByRole('region', { name: '选择数据库' });
  await button('取消全选').click();
  assert.equal(await scanDatabases.getByRole('checkbox', { checked: true }).count(), 0);
  assert.equal(await button('开始扫描').isDisabled(), true);
  await button('全选').click();
  assert.equal(
    await scanDatabases.getByRole('checkbox', { checked: true }).count(),
    await scanDatabases.getByRole('checkbox').count(),
  );
  await page.getByRole('checkbox', { name: /unsupported.db/ }).uncheck();
  await capture('scan-desktop');
  await button('开始扫描').click();
  await button('暂停扫描').waitFor();
  assert.equal(await page.getByRole('radiogroup', { name: '体检类型' }).count(), 0);
  assert.equal(await tab('报告').isDisabled(), true);
  assert.equal(await tab('修复').isDisabled(), true);
  await page.evaluate(() => window.maintenanceQa.complete());
  await button('前往补充检查').waitFor();
  assert.equal(await tab('报告').getAttribute('aria-selected'), 'true');
  await page.getByText('发现 1 个坏页，尚未定位', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: '查看 unsupported.db 检查详情' }).count(), 0);
  await button('JSON').click();
  await capture('report-unlocated-desktop');
  await button('查看修复方案').click();
  await page.getByRole('heading', { name: 'nt_msg.db · 快速修复' }).waitFor();
  await page.getByRole('checkbox', { name: '使用深度修复' }).check();
  await page.getByRole('heading', { name: 'nt_msg.db · 深度修复' }).waitFor();
  await page.getByRole('checkbox', { name: '使用深度修复' }).uncheck();
  await tab('扫描').click();
  await button('追加扫描').waitFor();
  await capture('scan-after-completion-desktop');
  await tab('报告').click();
  await button('前往补充检查').click();
  await page.getByRole('radio', { checked: true, name: '深度体检' }).waitFor();
  await button('开始补充检查').click();
  await button('暂停扫描').waitFor();
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
  await button('暂停扫描').click();
  await page.getByRole('radio', { name: '快速体检', exact: true }).click();
  await page.getByRole('radio', { name: '深度体检', exact: true }).click();
  await button('继续扫描').click();
  await button('暂停扫描').waitFor();
  await page.evaluate(() => window.maintenanceQa.complete());
  await button('查看修复方案').waitFor();
  assert.equal(await tab('报告').getAttribute('aria-selected'), 'true');
  await page.getByText('空闲叶页 · 页 4,663,083', { exact: true }).waitFor();
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
  await button('查看修复方案').click();
  await page.getByRole('heading', { name: 'nt_msg.db · 快速修复' }).waitFor();
  await capture('quick-plan-desktop');
  await button('开始修复').click();
  await page.getByRole('dialog').getByRole('button', { name: '开始修复' }).click();
  await button('停止修复').waitFor();
  await tab('扫描').click();
  await page.evaluate(() => window.maintenanceQa.failQuick());
  await button('查看深度修复方案').waitFor();
  await button('查看深度修复方案').click();
  await page.getByRole('heading', { name: 'nt_msg.db · 深度修复' }).waitFor();
  await page.setViewportSize({ width: 680, height: 780 });
  await page.evaluate(() => {
    window.maintenanceQa.theme.getState().setPreference('dark');
    window.maintenanceQa.theme.getState().setAccent('#91d7ad');
  });
  await capture('deep-plan-narrow-dark');
  await button('开始修复').click();
  await page.getByRole('dialog').getByRole('button', { name: '开始修复' }).click();
  await button('停止修复').waitFor();
  await page.evaluate(() => window.maintenanceQa.repair());
  await page.getByText('恢复表数据', { exact: true }).waitFor();
  await capture('repair-progress-narrow-dark');
  await button('停止修复').click();
  await page.waitForFunction(() => window.maintenanceQa.snapshot().locked === false);
  assert.equal(await tab('修复').isDisabled(), true);
  assert.equal(await tab('报告').getAttribute('aria-selected'), 'true');
  assert.deepEqual(
    await page.evaluate(() =>
      window.maintenanceQa.calls.repair.map((call) => call.methods['nt_msg.db']),
    ),
    ['quick', 'deep'],
  );
  assert.deepEqual(errors, []);
  console.log(
    '数据库维护：全选和取消全选、扫描模式与暂停、历史与设置浮层、导出、持锁等待、修复和代表布局通过。',
  );
} finally {
  await browser?.close();
  await server.close();
}
