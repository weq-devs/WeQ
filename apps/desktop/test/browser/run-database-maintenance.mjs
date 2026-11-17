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
  await page.getByRole('button', { name: '开始扫描', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.maintenanceQa.calls.scan.length), 0);
  await page.getByRole('button', { name: '深度体检', exact: true }).click();
  await page.evaluate(() => window.maintenanceQa.structure());
  await page.getByText('检查页结构与引用', { exact: true }).waitFor();
  assert.equal(
    Number(await page.getByRole('progressbar').last().getAttribute('value')),
    (800 / 2048) * 100,
  );
  await capture('deep-active-desktop');

  await page.evaluate(() => window.maintenanceQa.complete());
  await page.getByText(/数据库仍在维护中，等待决定/).waitFor();
  await page.setViewportSize({ width: 680, height: 780 });
  await page.evaluate(() => {
    window.maintenanceQa.theme.getState().setPreference('dark');
    window.maintenanceQa.theme.getState().setAccent('#91d7ad');
  });
  await capture('waiting-narrow-dark');
  assert.equal(
    await page.getByRole('checkbox', { name: '修复 nt_msg.db', exact: true }).isChecked(),
    true,
  );
  assert.equal(
    await page.getByRole('checkbox', { name: '修复 profile.db', exact: true }).isEnabled(),
    true,
  );
  await page.getByRole('checkbox', { name: '修复 profile.db', exact: true }).check();
  await page.getByRole('button', { name: '修复所选数据库', exact: true }).click();
  await page.getByRole('button', { name: '开始修复', exact: true }).click();
  await page.evaluate(() => window.maintenanceQa.repair());
  await page.getByText('恢复表数据', { exact: true }).waitFor();
  assert.equal(await page.getByRole('progressbar').last().getAttribute('value'), null);
  await page.setViewportSize({ width: 1060, height: 780 });
  await page.evaluate(() => window.maintenanceQa.theme.getState().setPreference('light'));
  await capture('repair-desktop');
  await page.getByRole('button', { name: '停止修复', exact: true }).click();
  await page.getByRole('button', { name: '重新扫描', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.maintenanceQa.snapshot().locked), false);
  assert.deepEqual(errors, []);
  console.log('数据库维护：主动启动、深度步骤、持锁等待、健康库勾选、停止修复及三处代表布局通过。');
} finally {
  await browser?.close();
  await server.close();
}
