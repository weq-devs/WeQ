import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-qq-debug-copy'),
  plugins: [react(), tailwind()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/qq-debug-copy.stub.ts'),
      },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  optimizeDeps: {
    entries: ['test/browser/qq-debug-copy.html'],
    include: [
      'react',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'lucide-react',
      'zustand',
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
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.electron = { process: { platform: 'darwin' } };
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qq-debug-copy.html`,
  );
  await page.getByRole('button', { name: '创建副本', exact: true }).waitFor();
  await page.evaluate(() =>
    window.debugCopyQa.setFixture({
      state: 'ready',
      readerReady: false,
      version: '7.0.1-1',
      message: '副本签名与调试权限已就绪；启动并登录后检查在线凭据。',
    }),
  );
  await page.getByText('当前构建缺少调试权限', { exact: true }).waitFor();
  if (await page.getByRole('button', { name: '启动副本', exact: true }).isDisabled())
    throw new Error('读取端缺少权限不应阻止启动副本');
  const output = process.env.WEQ_DEBUG_COPY_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  await page.getByRole('button', { name: '权限设置', exact: true }).click();
  const permissions = page.getByRole('region', { name: '副本权限引导' });
  await permissions.waitFor();
  await permissions.getByRole('button', { name: '打开录屏设置', exact: true }).click();
  await permissions.getByText('已请求打开系统设置，副本权限仍待确认。', { exact: true }).waitFor();
  await permissions.getByText('仍无法截图', { exact: true }).click();
  let cases = 0;
  for (const width of [1180, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark', 'system']) {
      await page.emulateMedia({
        colorScheme: theme === 'light' ? 'light' : 'dark',
        reducedMotion: 'reduce',
      });
      for (const accent of ['#075c30', '#fff3a1'])
        for (const background of ['plain', 'telegram']) {
          await page.evaluate(
            ({ theme, accent, background }) => {
              const store = window.debugCopyQa.store.getState();
              store.setPreference(theme);
              store.setAccent(accent);
              store.setBackground(background);
            },
            { theme, accent, background },
          );
          const overflow = await page.evaluate(
            () =>
              [
                ...document.querySelectorAll(
                  '.weq-qq-debug, .weq-qq-debug-actions button, .weq-qq-debug-checks strong, .weq-qq-debug-details dd, .weq-qq-debug-permissions, .weq-qq-debug-permission-path, .weq-qq-debug-permission-troubleshoot code',
                ),
              ].some((node) => node.scrollWidth > node.clientWidth + 1) ||
              document.documentElement.scrollWidth > innerWidth,
          );
          if (overflow) throw new Error(`布局溢出：${width} ${theme} ${accent} ${background}`);
          const buttonStyles = await page
            .locator('.weq-qq-debug-actions button')
            .evaluateAll((buttons) =>
              buttons.map((button) => {
                const style = getComputedStyle(button);
                return [style.height, style.borderRadius, style.padding].join('|');
              }),
            );
          if (new Set(buttonStyles).size !== 1) throw new Error('副本操作按钮样式不一致');
          if (output && accent === '#075c30' && background === 'plain')
            await page.screenshot({
              path: resolve(output, `${width}-${theme}.png`),
              fullPage: true,
            });
          cases++;
        }
    }
  }
  for (const [value, label] of [
    ['microphone', '麦克风'],
    ['camera', '摄像头'],
  ]) {
    await permissions.getByRole('combobox', { name: '按需设置' }).selectOption(value);
    await permissions.getByRole('button', { name: `打开${label}设置`, exact: true }).click();
    await permissions
      .getByText('已请求打开系统设置，副本权限仍待确认。', { exact: true })
      .waitFor();
    if (await permissions.locator('details').count())
      throw new Error('其他权限不能展示录屏重置命令');
  }
  await permissions.getByRole('button', { name: '稍后设置', exact: true }).click();
  await permissions.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '更新副本', exact: true }).click();
  await page.getByText('副本已准备好，请启动并登录目标账号。', { exact: true }).waitFor();
  if (await permissions.count()) throw new Error('准备成功不应自动展开权限引导');
  await page.getByRole('button', { name: '权限设置', exact: true }).click();
  await permissions.waitFor();
  await page.getByRole('button', { name: '启动副本', exact: true }).click();
  await page.getByText('正在运行，登录状态待检查', { exact: true }).waitFor();
  if (!(await page.getByRole('button', { name: '更新副本', exact: true }).isDisabled()))
    throw new Error('运行中不能更新');
  if (
    !(await permissions.getByRole('button', { name: '授权后启动副本', exact: true }).isDisabled())
  )
    throw new Error('权限引导不能重复启动运行中的副本');
  await page.evaluate(() => window.debugCopyQa.setFixture({ phase: 'signing', runningPids: [] }));
  await page.getByText('正在配置调试签名', { exact: true }).waitFor();
  const animation = await page
    .locator('.weq-qq-debug-progress svg')
    .evaluate((node) => getComputedStyle(node).animationName);
  if (animation !== 'none') throw new Error('减少动态效果未生效');
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qq-debug-copy.html?startup=1`,
  );
  for (const width of [1180, 390, 320]) {
    await page.setViewportSize({ width, height: 760 });
    await page.getByRole('button', { name: 'QQ 调试副本', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'QQ 调试副本', exact: true });
    await dialog.waitFor();
    const bounds = await dialog.boundingBox();
    if (
      !bounds ||
      bounds.x < 0 ||
      bounds.x + bounds.width > width + 1 ||
      bounds.y < 0 ||
      bounds.y + bounds.height > 761
    )
      throw new Error(`启动页副本面板越界：${width}`);
    if (output) await page.screenshot({ path: resolve(output, `startup-${width}.png`) });
    await page.evaluate(() => window.debugCopyQa.setFixture({ state: 'ready' }));
    await dialog.getByRole('button', { name: '权限设置', exact: true }).click();
    await dialog.getByRole('region', { name: '副本权限引导' }).waitFor();
    await dialog.getByRole('button', { name: '稍后设置', exact: true }).click();
    await dialog.getByRole('button', { name: '移除副本', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '移除 QQ 调试副本', exact: true });
    await confirmation.waitFor();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click({ timeout: 5000 });
    await confirmation.waitFor({ state: 'detached' });
    await dialog.getByRole('button', { name: '移除副本', exact: true }).click();
    await confirmation.waitFor();
    await page.keyboard.press('Escape');
    await confirmation.waitFor({ state: 'detached' });
    await dialog.getByRole('button', { name: '移除副本', exact: true }).click();
    await confirmation
      .getByRole('button', { name: '移除副本', exact: true })
      .click({ timeout: 5000 });
    await dialog.getByRole('button', { name: '创建副本', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭调试副本', exact: true }).click();
  }
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qq-debug-copy.html?restricted=1&recovery=1`,
      );
      await page.getByRole('button', { name: '受限模式', exact: true }).click();
      await page.evaluate((theme) => {
        window.debugCopyQa.store.getState().setPreference(theme);
        window.debugCopyQa.setOnlineFixture({
          credentialsPending: true,
          hasD2: false,
          ssoReady: false,
        });
        window.debugCopyQa.setFixture({ state: 'ready', sourceRunningPids: [51] });
      }, theme);
      await page.waitForFunction(() =>
        document
          .querySelector('.weq-restricted-indicator')
          ?.textContent.includes('正在启用完整功能'),
      );
      await page.evaluate(() => window.debugCopyQa.restrictedStore.getState().setOpen(true));
      const panel = page.locator('.weq-restricted-panel');
      const switchQq = panel.getByRole('button', { name: '退出普通 QQ 并打开副本', exact: true });
      if (await switchQq.isDisabled()) throw new Error('凭据等待期间应允许明确切换调试副本');
      await panel.locator('.weq-restricted-more summary').click();
      await panel.getByRole('button', { name: '副本设置', exact: true }).click();
      await page.getByRole('dialog', { name: 'QQ 调试副本', exact: true }).waitFor();
      await page.getByRole('button', { name: '关闭副本设置', exact: true }).click();
      await panel.locator('.weq-restricted-more summary').click();
      if (await panel.evaluate((node) => node.scrollWidth > node.clientWidth + 1))
        throw new Error('切换调试副本入口溢出');
      if (output) await page.screenshot({ path: resolve(output, `switch-${width}-${theme}.png`) });
      await switchQq.click();
      await switchQq.waitFor({ state: 'detached' });
    }
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qq-debug-copy.html?restricted=1`,
  );
  await page.getByRole('button', { name: '受限模式', exact: true }).click();
  await page.locator('.weq-restricted-panel .weq-restricted-qq').waitFor();
  let restrictedCases = 0;
  for (const width of [1180, 390])
    for (const theme of ['light', 'dark'])
      for (const state of ['missing', 'ready', 'outdated', 'invalid']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          ({ theme, state }) => {
            window.debugCopyQa.store.getState().setPreference(theme);
            window.debugCopyQa.setFixture({ state, runningPids: [] });
          },
          { theme, state },
        );
        const panel = page.locator('.weq-restricted-panel');
        if ((await panel.locator('.weq-restricted-qq').getByRole('button').count()) !== 1)
          throw new Error('QQ 引导默认只能显示一个主操作');
        if (await panel.locator('.weq-qq-debug-checks, .weq-qq-debug-details').count())
          throw new Error('受限详情不应铺开副本状态和路径');
        const label =
          state === 'missing' ? '准备并打开 QQ' : state === 'invalid' ? '修复并打开 QQ' : '打开 QQ';
        await panel.getByRole('button', { name: label, exact: true }).waitFor();
        if (await panel.evaluate((node) => node.scrollWidth > node.clientWidth + 1))
          throw new Error('精简受限面板溢出');
        if (output)
          await page.screenshot({
            path: resolve(output, `recheck-${width}-${theme}-${state}.png`),
          });
        restrictedCases++;
      }
  for (const width of [1180, 390])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        window.debugCopyQa.store.getState().setPreference(theme);
        window.debugCopyQa.setFixture({ state: 'ready', runningPids: [42] });
      }, theme);
      const restrictedPanel = page.locator('.weq-restricted-panel');
      await restrictedPanel.getByRole('button', { name: '登录其他账号', exact: true }).waitFor();
      if (
        await restrictedPanel
          .getByRole('button', { name: '登录其他账号', exact: true })
          .isDisabled()
      )
        throw new Error('其他账号运行中仍应允许启动新实例');
      await restrictedPanel.locator('.weq-restricted-more summary').click();
      await restrictedPanel
        .getByRole('button', { name: '打开已有 QQ 窗口', exact: true })
        .waitFor();
      await restrictedPanel.getByRole('button', { name: '副本设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'QQ 调试副本', exact: true });
      await settings.waitFor();
      await page.evaluate(() => window.debugCopyQa.setFixture({ runningPids: [] }));
      await settings.getByRole('button', { name: '移除副本', exact: true }).click();
      const removeConfirmation = page.getByRole('dialog', {
        name: '移除 QQ 调试副本',
        exact: true,
      });
      await removeConfirmation.waitFor();
      if (output) await page.screenshot({ path: resolve(output, `remove-${width}-${theme}.png`) });
      await removeConfirmation
        .getByRole('button', { name: '取消', exact: true })
        .click({ timeout: 5000 });
      if (!(await restrictedPanel.isVisible())) throw new Error('取消移除不应关闭受限详情');
      await settings.getByRole('button', { name: '移除副本', exact: true }).click();
      await removeConfirmation.waitFor();
      await removeConfirmation.getByRole('button', { name: '取消', exact: true }).focus();
      for (let index = 0; index < 6; index++) {
        await page.keyboard.press('Tab');
        if (!(await removeConfirmation.evaluate((node) => node.contains(document.activeElement))))
          throw new Error('确认框的键盘焦点不能逃到受限详情');
      }
      await page.keyboard.press('Escape');
      await removeConfirmation.waitFor({ state: 'detached' });
      if (!(await restrictedPanel.isVisible())) throw new Error('Esc 应仅关闭确认框');
      await settings.getByRole('button', { name: '移除副本', exact: true }).click();
      await removeConfirmation
        .getByRole('button', { name: '移除副本', exact: true })
        .click({ timeout: 5000 });
      await settings.getByRole('button', { name: '创建副本', exact: true }).waitFor();
      await page.getByRole('button', { name: '关闭副本设置', exact: true }).click();
      await restrictedPanel.locator('.weq-restricted-more summary').click();
    }
  await page.evaluate(() => {
    window.weq = { authorization: {} };
    const store = window.debugCopyQa.restrictedStore.getState();
    store.request({ kind: 'password', token: 41, title: '合成授权', message: 'synthetic' });
    store.request({ kind: 'ptrace', token: 42, title: '合成读取', message: 'synthetic' });
    store.setOpen(true);
  });
  await page.getByRole('button', { name: '管理长期授权', exact: true }).waitFor();
  if (
    (await page.getByRole('button', { name: '管理长期授权', exact: true }).count()) !== 1 ||
    (await page.getByRole('button', { name: '重新检查', exact: true }).count()) !== 1
  )
    throw new Error('多项授权时公共操作入口重复');
  let offlineCases = 0;
  for (const view of ['main', 'startup']) {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qq-debug-copy.html?restricted=1&offline=1${view === 'startup' ? '&startup-offline=1' : ''}`,
    );
    await page.getByRole('button', { name: '受限模式', exact: true }).click();
    const panel = page.locator('.weq-restricted-panel');
    await panel.getByText('QQ 不在线', { exact: true }).waitFor();
    await panel.getByText('请在 QQ 调试副本中登录当前账号', { exact: false }).waitFor();
    if (await panel.getByRole('button', { name: '启动 QQ', exact: true }).count())
      throw new Error('SIP 开启的离线引导不能启动普通 QQ');
    for (const width of [1180, 390])
      for (const theme of ['light', 'dark'])
        for (const accent of ['#075c30', '#fff3a1']) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(
            ({ theme, accent }) => {
              window.debugCopyQa.store.getState().setPreference(theme);
              window.debugCopyQa.store.getState().setAccent(accent);
            },
            { theme, accent },
          );
          if (
            await panel.evaluate(
              (node) =>
                node.scrollWidth > node.clientWidth + 1 ||
                [...node.querySelectorAll('p, button')].some(
                  (item) => item.scrollWidth > item.clientWidth + 1,
                ),
            )
          )
            throw new Error(`离线副本引导溢出：${view} ${width} ${theme} ${accent}`);
          if (output && accent === '#075c30')
            await page.screenshot({
              path: resolve(output, `offline-${view}-${width}-${theme}.png`),
            });
          offlineCases++;
        }
    if (view === 'main') {
      await panel.getByRole('button', { name: '准备并打开 QQ', exact: true }).click();
      await panel.getByText('请在 QQ 中完成登录，登录后会自动继续。', { exact: true }).waitFor();
      if (await page.getByRole('region', { name: '副本权限引导' }).count())
        throw new Error('一键打开不应自动展开权限引导');
      await page.evaluate(() => window.debugCopyQa.setOnlineFixture({ qqOnline: true }));
      await page
        .getByRole('button', { name: '受限模式', exact: true })
        .waitFor({ state: 'detached' });
      await panel.waitFor({ state: 'detached' });
    }
  }
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qq-debug-copy.html?restricted=1&offline=1&pending-status=1`,
      );
      await page.getByRole('button', { name: '受限模式', exact: true }).click();
      await page.evaluate((theme) => {
        window.debugCopyQa.store.getState().setPreference(theme);
        window.debugCopyQa.pauseAction();
      }, theme);
      const panel = page.locator('.weq-restricted-panel');
      const open = panel.getByRole('button', { name: '打开 QQ', exact: true });
      if (await open.isDisabled()) throw new Error('首次状态尚未返回时必须允许打开 QQ');
      const initialWidth = (await open.boundingBox())?.width;
      if (output) await page.screenshot({ path: resolve(output, `instant-${width}-${theme}.png`) });
      await open.click();
      const checking = panel.getByRole('button', { name: '正在检查 QQ', exact: true });
      await checking.waitFor();
      if (!(await checking.isDisabled())) throw new Error('提交后必须禁止重复打开');
      await page.evaluate(() => {
        window.debugCopyQa.setFixture({ phase: 'copying' });
        window.debugCopyQa.setStatusPending(false);
      });
      await panel.getByRole('button', { name: '正在准备 QQ', exact: true }).waitFor();
      if (
        (await panel.getByRole('button', { name: '正在准备 QQ', exact: true }).boundingBox())
          ?.width !== initialWidth
      )
        throw new Error('主按钮不能随进度文案改变宽度');
      if (
        await panel.evaluate((node) =>
          [...node.querySelectorAll('button')].some(
            (button) => button.scrollWidth > button.clientWidth + 1,
          ),
        )
      )
        throw new Error(`打开进度按钮溢出：${width} ${theme}`);
      if (output)
        await page.screenshot({ path: resolve(output, `progress-${width}-${theme}.png`) });
      await page.evaluate(() => window.debugCopyQa.resumeAction());
      await panel.getByText('请在 QQ 中完成登录，登录后会自动继续。', { exact: true }).waitFor();
    }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    `通过 ${cases} 组权限引导视口/主题/主题色/背景布局、6 组凭据等待中切换副本与设置交互、${restrictedCases} 组精简受限面板检查、${offlineCases} 组离线副本引导、6 组首次查询未返回时立即打开与进度检查、4 组副本设置与移除确认交互，以及三类权限入口、按需引导、多账号入口、运行中保护和减少动态效果检查。`,
  );
} finally {
  await browser?.close();
  await server.close();
}
