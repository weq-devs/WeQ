import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-settings-audit'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('electron') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/settings-audit.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
const sections = [
  ['database-management', ['启用数据库监听', '检查与修复']],
  ['account', ['自动启用 QQ 在线能力']],
  ['resource-loading', ['优先直连 QQ 加载图片', '允许使用外部安卓图片缓存']],
  ['appearance', ['使用仿 Windows 窗口按钮']],
  ['credentials', ['密钥扫描', '其他设备密钥']],
];
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const errors = [];
  let cases = 0;
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultNavigationTimeout(120000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.electron = {
      process: { platform: 'linux' },
      ipcRenderer: { on: () => () => {}, invoke: async () => undefined, send: () => {} },
    };
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  for (const width of [390, 1180]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      for (const [section, labels] of sections) {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-audit.html?section=${section}`,
        );
        await page.evaluate((theme) => {
          const store = window.settingsAuditQa.theme.getState();
          store.setPreference(theme);
          store.setAccent(theme === 'light' ? '#b5243e' : '#81c995');
          store.setBackground(theme === 'light' ? 'grid' : 'telegram');
        }, theme);
        const body = page.locator('.weq-settings-body');
        for (const text of labels) {
          const label = body.locator('.weq-set-row-label').getByText(text, { exact: true });
          await label.waitFor();
          assert.equal(await label.locator('svg, img').count(), 0, text);
        }
        assert.equal(
          await body.locator('.weq-set-row-label svg, .weq-set-row-label img').count(),
          0,
        );
        assert((await body.locator('.weq-set-card-icon svg').count()) > 0);
        if (section === 'database-management' || section === 'credentials')
          assert((await body.locator('.weq-set-row-ctrl button svg').count()) > 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        const misaligned = await body.locator('.weq-set-card').evaluateAll((cards) =>
          cards.flatMap((card) => {
            const rows = [
              ...card.querySelectorAll(
                '.weq-set-row:not(.is-indent) > .weq-set-row-main > .weq-set-row-label',
              ),
            ];
            const left = rows[0]?.getBoundingClientRect().left;
            return rows
              .filter((row) => Math.abs(row.getBoundingClientRect().left - left) > 1)
              .map((row) => row.textContent);
          }),
        );
        assert.deepEqual(misaligned, [], `${section}: 同级标签左对齐`);
        if (output) {
          await body.locator('.weq-set-card').last().scrollIntoViewIfNeeded();
          await page.screenshot({ path: resolve(output, `${section}-${width}-${theme}.png`) });
        }
        cases++;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    `四级设置标签图标、分组与操作图标保留、同级对齐及深浅主题窄屏检查通过：${cases} 个场景`,
  );
} finally {
  await browser?.close();
  await server.close();
}
