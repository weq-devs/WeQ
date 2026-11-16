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
  await page.goto(url);
  await page.getByRole('table', { name: '受限模式与完整功能对照' }).waitFor();
  assert.equal(await page.locator('[data-setting-id="qq-debug-copy"] .weq-qq-debug').count(), 0);
  await page.getByText('副本状态与管理', { exact: true }).click();
  await page.getByRole('button', { name: '启动副本', exact: true }).waitFor();
  await page.getByRole('button', { name: '启动副本', exact: true }).click();
  await page
    .getByText('已请求打开副本，请在副本中登录目标账号，再检查在线凭据。', { exact: true })
    .waitFor();
  await page.getByText('副本状态与管理', { exact: true }).click();
  await page
    .locator('[data-setting-id="qq-debug-copy"] .weq-qq-debug')
    .waitFor({ state: 'detached' });
  const auto = page.getByRole('switch', { name: '自动启用完整功能', exact: true });
  await auto.click();
  assert.equal(await auto.getAttribute('aria-checked'), 'false');
  const banner = page.getByRole('switch', { name: '进入受限模式时横幅提醒', exact: true });
  const inlineReminder = (await banner.count()) > 0;
  if (inlineReminder) {
    await banner.click();
    assert.equal(await banner.getAttribute('aria-checked'), 'false');
  } else {
    await page.getByRole('button', { name: '受限模式提醒设置', exact: true }).waitFor();
  }
  assert.deepEqual(
    await page.evaluate(() => window.fullFunctionsQa.saves),
    inlineReminder ? ['setAutoAttachQq', 'setRestrictedModeBannerEnabled'] : ['setAutoAttachQq'],
  );
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      for (const accent of ['#075c30', '#fff3a1']) {
        await page.evaluate(
          ({ theme, accent }) => {
            const store = window.fullFunctionsQa.theme.getState();
            store.setPreference(theme);
            store.setAccent(accent);
            store.setBackground(theme === 'light' ? 'plain' : 'telegram');
          },
          { theme, accent },
        );
        const contrast = await page
          .locator('[data-setting-id="qq-debug-copy"] summary')
          .evaluate((node) => {
            const paint = document.createElement('canvas').getContext('2d');
            const luminance = (color) => {
              paint.clearRect(0, 0, 1, 1);
              paint.fillStyle = color;
              paint.fillRect(0, 0, 1, 1);
              return [...paint.getImageData(0, 0, 1, 1).data]
                .slice(0, 3)
                .reduce((sum, value, i) => {
                  const channel = value / 255;
                  return (
                    sum +
                    (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) *
                      [0.2126, 0.7152, 0.0722][i]
                  );
                }, 0);
            };
            const levels = [
              luminance(getComputedStyle(node).color),
              luminance(getComputedStyle(node.closest('main')).backgroundColor),
            ].sort((a, b) => b - a);
            return (levels[0] + 0.05) / (levels[1] + 0.05);
          });
        assert.ok(contrast >= 4.5, `${width}-${theme}-${accent}: summary contrast ${contrast}`);
        for (const expanded of [false, true]) {
          await page.locator('[data-setting-id="qq-debug-copy"] details').evaluate((node, open) => {
            node.open = open;
          }, expanded);
          if (expanded)
            await page.getByRole('button', { name: /^(启动副本|登录其他账号)$/ }).waitFor();
          else await page.locator('.weq-qq-debug').waitFor({ state: 'detached' });
          const layout = await page.locator('main').evaluate((root) => ({
            overflow: root.scrollWidth > root.clientWidth + 1,
            clipped: [...root.querySelectorAll('th,td,h4,h5,button,.weq-set-row-main')]
              .filter((node) => node.scrollWidth > node.clientWidth + 1)
              .map((node) => node.textContent),
            nestedCards: root.querySelectorAll('.weq-set-card .weq-set-card').length,
            oldName: root.textContent.includes('完整模式'),
          }));
          assert.deepEqual(layout, {
            overflow: false,
            clipped: [],
            nestedCards: 0,
            oldName: false,
          });
          if (output && accent === '#075c30' && width !== 320)
            await page.screenshot({
              path: resolve(output, `${width}-${theme}-${expanded ? 'expanded' : 'overview'}.png`),
              fullPage: true,
            });
          cases++;
        }
      }
    }
  }
  for (const query of ['?platform=linux', '?platform=win32', '?sip-off', '?sip-error']) {
    await page.goto(url + query);
    await page.getByRole('table').waitFor();
    if (query.includes('platform')) {
      assert.equal(await page.locator('[data-setting-id="qq-debug-copy"]').count(), 0);
      assert.equal((await page.locator('main').textContent()).includes('SIP'), false);
    } else {
      await page
        .getByText(query === '?sip-off' ? '当前系统：SIP 已关闭' : 'SIP 状态检测失败', {
          exact: true,
        })
        .waitFor();
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      { cases, platformCases: 4, toggles: true, debugManagement: true, errors },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
