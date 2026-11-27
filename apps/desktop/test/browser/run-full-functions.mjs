import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const output = process.env.WEQ_FULL_FUNCTION_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-full-functions'),
  plugins: [react(), tailwind()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/full-functions.stub.ts'),
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
  await page.addInitScript(() => {
    const status = { platform: 'darwin', state: 'ready', message: '合成的权限助手已连接。' };
    window.weq = {
      authorization: {
        status: async () => status,
        install: async () => status,
        remove: async () => ({ ...status, state: 'not-installed' }),
      },
    };
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/full-functions.html`;
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto(url + '?sip-off&offline');
  const main = page.locator('main');
  const options = main.getByRole('radiogroup', { name: 'QQ 能力档位' });
  assert.equal(await options.getByRole('radio').count(), 4);
  const local = options.getByRole('radio', { name: '本地模式', exact: true });
  const online = options.getByRole('radio', { name: '在线模式', exact: true });
  const complete = options.getByRole('radio', { name: '完整模式', exact: true });
  const prepare = main.locator('[data-setting-id="full-feature-routes"]');
  await prepare.getByRole('button', { name: '使用原版 QQ', exact: true }).waitFor();
  await prepare.getByRole('button', { name: '使用调试副本', exact: true }).waitFor();
  await prepare.getByRole('button', { name: '副本设置', exact: true }).click();
  const manager = page.locator('.weq-qq-debug-modal');
  await manager.waitFor();
  await manager.getByRole('button', { name: '启动副本', exact: true }).click();
  await manager
    .getByText('已请求打开副本，请在副本中登录目标账号，再检查在线凭据。', { exact: true })
    .waitFor();
  await manager.getByRole('button', { name: '关闭副本设置', exact: true }).click();
  await manager.waitFor({ state: 'detached' });

  await local.click();
  await options.getByRole('radio', { checked: true, name: '本地模式' }).waitFor();
  assert.equal(await prepare.count(), 0);
  await local.press('ArrowDown');
  await options.getByRole('radio', { checked: true, name: '在线模式' }).waitFor();
  assert.equal(await online.evaluate((node) => node === document.activeElement), true);
  await complete.click();
  await options.getByRole('radio', { checked: true, name: '完整模式' }).waitFor();
  const connection = main.locator('[data-setting-id="qq-proxy-connection"]');
  await connection.getByText('已连接', { exact: true }).waitFor();
  await page.evaluate(() => window.fullFunctionsQa.setProxyFixture({ connected: false }));
  await connection.getByText('未连接', { exact: true }).waitFor();
  assert.equal(await complete.getAttribute('aria-checked'), 'true');

  const reminder = main.getByRole('switch', { name: '显示 QQ 功能状态提示', exact: true });
  await reminder.click();
  assert.equal(await reminder.getAttribute('aria-checked'), 'false');
  assert.deepEqual(await page.evaluate(() => window.fullFunctionsQa.saves), [
    'local',
    'online',
    'complete',
    'setQqStatusIndicatorEnabled',
  ]);

  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(url + '?offline');
  await prepare.getByText(/本机 SIP 已开启/).waitFor();
  assert.equal(await prepare.getByRole('button', { name: '使用原版 QQ' }).count(), 0);
  const layout = await main.evaluate((root) => ({
    overflow: root.scrollWidth > root.clientWidth + 1,
    clipped: [...root.querySelectorAll('.weq-applock-method, .weq-applock-method-main')]
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => node.textContent),
  }));
  assert.deepEqual(layout, { overflow: false, clipped: [] });
  if (output) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: resolve(output, 'qq-capability-settings.png'), fullPage: true });
  }
  await page.goto(url + '?sip-error');
  await prepare.getByText('暂时无法确认本机 QQ 读取条件', { exact: true }).waitFor();
  await page.goto(url + '?platform=linux&offline');
  await main.getByRole('button', { name: '打开 QQ', exact: true }).waitFor();
  assert.equal(await prepare.count(), 0);
  await page.goto(url + '?welcome');
  const welcome = page.locator('.weq-welcome');
  await welcome.getByRole('button', { name: '以本地模式开始使用', exact: true }).waitFor();
  await welcome.getByRole('switch', { name: '允许扫描 QQ 内存' }).click();
  await welcome.getByRole('button', { name: '开启 QQ 在线能力并开始使用', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('四档设置、连接状态、调试副本、窄屏与首次使用入口通过。');
} finally {
  await browser?.close();
  await server.close();
}
