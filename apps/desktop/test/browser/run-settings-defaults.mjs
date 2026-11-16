import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_SETTINGS_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-settings-defaults'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/settings-defaults.stub.ts'),
      },
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-actions.html`,
  );
  const entry = page.getByRole('button', { name: '恢复全局默认设置', exact: true });
  await entry.waitFor();
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['light', 'dark', 'system']) {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.evaluate((theme) => {
        const store = window.settingsActionsQa.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        store.setBackground('grid');
      }, theme);
      await entry.click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('switch', { name: '清除 API 配置', exact: true }).waitFor();
      assert.equal(
        await dialog
          .getByRole('switch', { name: '清除 API 配置', exact: true })
          .getAttribute('aria-checked'),
        'false',
      );
      assert.equal(await dialog.getByRole('combobox', { name: '导出目录' }).inputValue(), 'keep');
      assert.equal(
        await dialog
          .getByRole('button', { name: '取消', exact: true })
          .evaluate((node) => node === document.activeElement),
        true,
      );
      const layout = await dialog.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const buttons = [...node.querySelectorAll('.weq-dialog-foot button')];
        const body = node.querySelector('.weq-dialog-body');
        return {
          bounded:
            box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
          noOverflow:
            node.scrollWidth <= node.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1,
          actionsVisible: buttons.every((button) => {
            const rect = button.getBoundingClientRect();
            return rect.width > 0 && rect.top >= box.top && rect.bottom <= box.bottom;
          }),
        };
      });
      assert.deepEqual(
        layout,
        { bounded: true, noOverflow: true, actionsVisible: true },
        `${width}/${theme}`,
      );
      if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(), 0);
      cases++;
    }
  }
  await entry.click();
  await page.getByRole('dialog').getByRole('button', { name: '确认恢复默认' }).click();
  await page.getByRole('dialog').getByRole('alert').getByText('合成恢复失败，可重新确认').waitFor();
  assert.equal(
    await page.getByRole('dialog').getByRole('button', { name: '确认恢复默认' }).isEnabled(),
    true,
  );
  for (const restore of ['applied', 'failed', 'pending']) {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-actions.html?restore=${restore}`,
    );
    await entry.waitFor();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          window.settingsActionsQa.getState().setPreference(theme);
        }, theme);
        const backup = page.locator('[data-backup]');
        assert.equal(await backup.getByText('最近一次恢复已应用', { exact: true }).count(), 0);
        if (restore === 'applied') {
          assert.equal(await backup.getByText('合成恢复提示', { exact: true }).count(), 0);
          assert.equal(await entry.isEnabled(), true);
        } else if (restore === 'failed') {
          await backup.getByText('最近一次恢复失败', { exact: true }).waitFor();
          await backup.getByText('合成恢复失败', { exact: true }).waitFor();
        } else {
          await backup.getByText('界面偏好待恢复', { exact: true }).waitFor();
          assert.equal(await backup.getByRole('button', { name: '改在此设备恢复' }).count(), 1);
          assert.equal(await entry.isDisabled(), true);
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
        );
        if (output)
          await page.screenshot({ path: resolve(output, `${restore}-${theme}-${width}.png`) });
        cases++;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      cases,
      errors,
      result: '全局恢复入口、默认保留、取消、失败重试、成功结果隐藏与布局通过',
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
