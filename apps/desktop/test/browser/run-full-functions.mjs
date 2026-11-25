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
  const comparison = page.locator('.weq-full-function-comparison-details');
  await comparison.waitFor();
  assert.deepEqual(
    await comparison.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        top: style.borderTopWidth,
        bottom: style.borderBottomWidth,
        bottomStyle: style.borderBottomStyle,
      };
    }),
    { top: '0px', bottom: '1px', bottomStyle: 'solid' },
  );
  assert.equal(await comparison.evaluate((node) => node.open), false);
  await comparison.locator('summary').click();
  await page.getByRole('table', { name: 'QQ 在线能力对照' }).waitFor();
  assert.equal(await page.locator('.weq-full-function-comparison td strong').count(), 4);
  await comparison.locator('summary').click();
  assert.equal(await page.locator('[data-setting-id="qq-debug-copy"] .weq-qq-debug').count(), 0);
  await page.getByRole('button', { name: '副本设置', exact: true }).click();
  const manager = page.locator('.weq-qq-debug-modal');
  await manager.waitFor();
  await page.getByRole('button', { name: '启动副本', exact: true }).waitFor();
  await page.getByRole('button', { name: '启动副本', exact: true }).click();
  await page
    .getByText('已请求打开副本，请在副本中登录目标账号，再检查在线凭据。', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: '关闭副本设置', exact: true }).click();
  await manager.waitFor({ state: 'detached' });
  const auto = page.getByRole('switch', { name: '启用 QQ 在线能力', exact: true });
  await auto.click();
  assert.equal(await auto.getAttribute('aria-checked'), 'false');
  const indicator = page.getByRole('switch', {
    name: '显示 QQ 功能状态提示',
    exact: true,
  });
  assert.equal(await indicator.getAttribute('aria-checked'), 'true');
  await indicator.click();
  assert.equal(await indicator.getAttribute('aria-checked'), 'false');
  await page.getByText('在线能力受限时通知', { exact: true }).waitFor();
  const onlineCapability = page.locator('[data-setting-id="full-features"]');
  const status = onlineCapability.getByRole('button', { name: /QQ 在线能力：.*，查看详情/ });
  await page.evaluate(() =>
    window.fullFunctionsQa.setOnlineFixture({
      qqOnline: true,
      attachEnabled: true,
      hasA2: true,
      hasD2: true,
      hasD2Key: true,
      hasGuid: true,
      hasUid: true,
      ssoReady: true,
    }),
  );
  await onlineCapability.getByRole('status').getByText('已就绪', { exact: true }).waitFor();
  assert.equal(await status.count(), 0);
  await page.evaluate(() => window.fullFunctionsQa.setOnlineFixture({ hasUid: false }));
  await page
    .getByRole('button', { name: 'QQ 在线能力：在线能力受限，查看详情', exact: true })
    .waitFor();
  await status.click();
  const restrictedDetails = page.getByRole('dialog', { name: 'QQ 功能状态', exact: true });
  await restrictedDetails.getByText('会话凭据不完整').waitFor();
  await page.keyboard.press('Escape');
  await restrictedDetails.waitFor({ state: 'detached' });
  assert.equal(await status.evaluate((node) => node === document.activeElement), true);
  await page.getByRole('combobox', { name: '功能受限或运行异常通知方式' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fullFunctionsQa.saves), [
    'setAutoAttachQq',
    'setQqStatusIndicatorEnabled',
  ]);
  const proxyCard = page.locator('[data-setting-id="qq-proxy-connection"]');
  await proxyCard.getByText('等待在线能力', { exact: true }).waitFor();
  await auto.click();
  for (const [id, label] of [
    ['qq-proxy-connection', '已连接'],
    ['long-term-authorization', '已授权'],
  ])
    await page.locator(`[data-setting-id="${id}"]`).getByText(label, { exact: true }).waitFor();
  await indicator.click();
  await page.evaluate(() => {
    window.fullFunctionsQa.setOnlineFixture({ qqOnline: false });
    window.fullFunctionsQa.setProxyFixture({ connected: false });
  });
  const unified = page.getByRole('button', { name: '在线能力受限', exact: true });
  await unified.click();
  assert.equal(await page.locator('.weq-restricted-indicator').count(), 1);
  await restrictedDetails.getByRole('region', { name: 'QQ 在线能力' }).waitFor();
  assert.equal(await restrictedDetails.getByRole('region', { name: 'QQ 代理连接' }).count(), 0);
  assert.equal(
    await restrictedDetails.getByRole('button', { name: '打开 QQ', exact: true }).count(),
    1,
  );
  assert.equal(
    await restrictedDetails.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.right <= innerWidth && rect.bottom <= innerHeight;
    }),
    true,
  );
  if (output) {
    await mkdir(output, { recursive: true });
    await restrictedDetails.screenshot({ path: resolve(output, 'qq-function-status.png') });
  }
  await page.keyboard.press('Escape');
  await restrictedDetails.waitFor({ state: 'detached' });
  assert.equal(await unified.evaluate((node) => node === document.activeElement), true);
  await page.evaluate(() => {
    window.fullFunctionsQa.setOnlineFixture({ qqOnline: true, hasUid: true });
    window.fullFunctionsQa.setProxyFixture({ connected: true });
  });
  for (const style of ['classic', 'retro', 'qqnt']) {
    await page.evaluate(
      (style) => window.fullFunctionsQa.theme.getState().setComponentStyle(style),
      style,
    );
    const groups = await page.locator('main').evaluate((root) => {
      const readStyle = (id) => {
        const node = root.querySelector(`[data-setting-id="${id}"]`);
        const style = getComputedStyle(node);
        const title = getComputedStyle(node.querySelector('.weq-set-card-title'));
        return {
          radius: style.borderRadius,
          padding: style.padding,
          border: style.border,
          background: style.backgroundColor,
          title: [title.fontSize, title.fontWeight, title.lineHeight],
          x: node.getBoundingClientRect().x,
          width: node.getBoundingClientRect().width,
        };
      };
      return ['long-term-authorization', 'full-features', 'qq-proxy-connection'].map(readStyle);
    });
    assert.deepEqual(groups[1], groups[0], `${style}: QQ 在线能力分组与设置基线不一致`);
    assert.deepEqual(groups[2], groups[0], `${style}: QQ 代理连接分组与设置基线不一致`);
  }
  for (const [id, title] of [
    ['full-feature-routes', '在线能力'],
    ['auto-full-mode', '在线能力'],
    ['qq-status-indicator', '状态提醒'],
    ['qq-client-sync', '同步与实时更新'],
    ['qq-live-messages', '同步与实时更新'],
  ])
    assert.equal(
      await page
        .locator(`[data-setting-id="${id}"]`)
        .evaluate(
          (node) =>
            node.closest('.weq-set-card')?.querySelector('.weq-set-card-title')?.textContent,
        ),
      title,
    );
  await page
    .getByRole('region', { name: 'QQ 调试副本路线', exact: true })
    .getByText('无需关闭 SIP（适用于本机）', { exact: true })
    .waitFor();
  await page
    .getByRole('region', { name: '原版 QQ 路线', exact: true })
    .getByText('需关闭 SIP', { exact: true })
    .waitFor();
  await page.evaluate(() => window.fullFunctionsQa.setOnlineFixture({ hasUid: true }));
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  let managerCases = 0;
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
          .locator('.weq-full-function-comparison-details > summary')
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
              luminance(getComputedStyle(node.closest('.weq-set-card')).backgroundColor),
            ].sort((a, b) => b - a);
            return (levels[0] + 0.05) / (levels[1] + 0.05);
          });
        assert.ok(contrast >= 4.5, `${width}-${theme}-${accent}: summary contrast ${contrast}`);
        for (const expanded of [false, true]) {
          await comparison.evaluate((node, open) => {
            node.open = open;
          }, expanded);
          await page.getByRole('table').waitFor({ state: expanded ? 'visible' : 'hidden' });
          const layout = await page.locator('main').evaluate((root) => ({
            overflow: root.scrollWidth > root.clientWidth + 1,
            wrappedLabels: [
              ...root.querySelectorAll('.weq-full-function-comparison tbody th'),
            ].filter((node) => {
              const range = document.createRange();
              range.selectNodeContents(node);
              const lines = [...range.getClientRects()].map((rect) => Math.round(rect.top));
              return new Set(lines).size > 1;
            }).length,
            clipped: [...root.querySelectorAll('th,td,h4,h5,button,.weq-set-row-main')]
              .filter((node) => node.scrollWidth > node.clientWidth + 1)
              .map((node) => node.textContent),
            nestedCards: root.querySelectorAll('.weq-set-card .weq-set-card').length,
            oldName: /完整(?:功能|模式|体验)/.test(root.textContent),
          }));
          assert.deepEqual(layout, {
            overflow: false,
            wrappedLabels: 0,
            clipped: [],
            nestedCards: 0,
            oldName: false,
          });
          const columns = await page.locator('.weq-full-function-routes').evaluate((node) => {
            const [copy, original] = [...node.children].map((child) =>
              child.getBoundingClientRect(),
            );
            return {
              sideBySide: Math.abs(copy.top - original.top) < 1 && original.left > copy.right,
              stacked: original.top >= copy.bottom,
            };
          });
          assert.equal(width === 1180 ? columns.sideBySide : columns.stacked, true);
          if (output && accent === '#075c30' && width !== 320)
            await page.screenshot({
              path: resolve(output, `${width}-${theme}-${expanded ? 'expanded' : 'overview'}.png`),
              fullPage: true,
            });
          cases++;
        }
        if (accent === '#075c30') {
          await page.getByRole('button', { name: '副本设置', exact: true }).click();
          await manager.waitFor();
          const bounds = await manager.boundingBox();
          assert.ok(
            bounds &&
              bounds.x >= 0 &&
              bounds.y >= 0 &&
              bounds.x + bounds.width <= width + 1 &&
              bounds.y + bounds.height <= 901,
          );
          if (output && width === 390)
            await page.screenshot({ path: resolve(output, `manager-${width}-${theme}.png`) });
          await page.getByRole('button', { name: '关闭副本设置', exact: true }).click();
          await manager.waitFor({ state: 'detached' });
          managerCases++;
        }
      }
    }
  }
  for (const query of ['?platform=linux', '?platform=win32', '?sip-off', '?sip-error']) {
    await page.goto(url + query);
    await page.locator('.weq-full-function-comparison-details').waitFor();
    if (query.includes('platform')) {
      assert.equal(await page.locator('[data-setting-id="qq-debug-copy"]').count(), 0);
      assert.equal((await page.locator('main').textContent()).includes('SIP'), false);
    } else if (query === '?sip-off') {
      await page.getByText('需关闭 SIP（适用于本机）', { exact: true }).waitFor();
      assert.equal(
        await page.locator('[aria-label="原版 QQ 路线"]').getAttribute('data-applicable'),
        'true',
      );
    } else {
      await page.getByText('SIP 状态检测失败', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-applicable="true"]').count(), 0);
    }
  }
  let welcomeCases = 0;
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url + '?welcome');
    const welcome = page.locator('.weq-welcome');
    await welcome.waitFor();
    await welcome.getByRole('button', { name: '以离线模式开始使用', exact: true }).waitFor();
    await welcome.getByRole('switch', { name: '允许扫描 QQ 内存' }).click();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => window.fullFunctionsQa.theme.getState().setPreference(theme),
        theme,
      );
      await welcome.getByText('开启 QQ 在线能力（推荐）', { exact: true }).waitFor();
      const action = welcome.getByRole('button', {
        name: '开启 QQ 在线能力并开始使用',
        exact: true,
      });
      assert.equal(await action.evaluate((node) => node.scrollWidth > node.clientWidth + 1), false);
      assert.equal(
        await welcome.evaluate((node) => node.scrollWidth > node.clientWidth + 1),
        false,
      );
      if (output && width === 390)
        await page.screenshot({ path: resolve(output, `welcome-${width}-${theme}.png`) });
      welcomeCases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        cases,
        platformCases: 4,
        styleCases: 4,
        welcomeCases,
        managerCases,
        toggles: true,
        debugManagement: true,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
