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
                  '.weq-qq-debug, .weq-qq-debug-actions button, .weq-qq-debug-checks strong, .weq-qq-debug-details dd',
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
            await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
          cases++;
        }
    }
  }
  await page.getByRole('button', { name: '更新副本', exact: true }).click();
  await page.getByText('副本已准备好，请启动并登录目标账号。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '启动副本', exact: true }).click();
  await page.getByText('正在运行，登录状态待检查', { exact: true }).waitFor();
  if (!(await page.getByRole('button', { name: '更新副本', exact: true }).isDisabled()))
    throw new Error('运行中不能更新');
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
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/qq-debug-copy.html?restricted=1`,
  );
  await page.getByRole('button', { name: '受限模式', exact: true }).click();
  await page.locator('.weq-restricted-panel .weq-qq-debug').waitFor();
  let restrictedCases = 0;
  for (const width of [1180, 390])
    for (const theme of ['light', 'dark'])
      for (const state of ['missing', 'ready']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          ({ theme, state }) => {
            window.debugCopyQa.store.getState().setPreference(theme);
            window.debugCopyQa.setFixture({ state });
          },
          { theme, state },
        );
        if ((await page.getByRole('button', { name: '重新检查', exact: true }).count()) !== 1)
          throw new Error('受限详情的重新检查入口重复');
        if (await page.getByRole('button', { name: '检查在线凭据', exact: true }).count())
          throw new Error('嵌入面板不应另设检查入口');
        await page.locator('.weq-restricted-body').evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
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
        window.debugCopyQa.setFixture({ state: 'ready' });
      }, theme);
      const restrictedPanel = page.locator('.weq-restricted-panel');
      await restrictedPanel.getByRole('button', { name: '移除副本', exact: true }).click();
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
      await restrictedPanel.getByRole('button', { name: '移除副本', exact: true }).click();
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
      await restrictedPanel.getByRole('button', { name: '移除副本', exact: true }).click();
      await removeConfirmation
        .getByRole('button', { name: '移除副本', exact: true })
        .click({ timeout: 5000 });
      await restrictedPanel.getByRole('button', { name: '创建副本', exact: true }).waitFor();
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
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    `通过 ${cases} 组视口/主题/主题色/背景布局、${restrictedCases} 组受限面板检查、4 组移除确认交互，以及创建、启动、运行中保护、减少动态效果和公共入口去重检查。`,
  );
} finally {
  await browser?.close();
  await server.close();
}
