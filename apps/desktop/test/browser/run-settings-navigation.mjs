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
  cacheDir: resolve(root, 'node_modules/.vite-settings-navigation'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/mobile-surfaces.stub.ts'),
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
  const errors = [];
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.clear());
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [390, 1180]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-navigation.html?display=1`,
      );
      await page.evaluate((theme) => {
        window.settingsNavigationQa.theme.getState().setPreference(theme);
        window.settingsNavigationQa.theme
          .getState()
          .setAccent(theme === 'light' ? '#b5243e' : '#81c995');
      }, theme);
      const metadata = page.locator('[data-setting-id="custom-message-display"]');
      assert.deepEqual(await metadata.locator('.weq-set-row-label').allTextContents(), [
        '显示消息序号（seq）',
        '显示发送日期',
        '显示发送时间',
      ]);
      const headings = page.locator('.weq-set-card-head .weq-set-card-title');
      assert((await headings.count()) >= 4);
      for (const heading of await headings.all()) {
        const icon = heading.locator('.weq-set-card-icon[aria-hidden] svg');
        assert.equal(await icon.count(), 1, `设置分组缺少图标：${await heading.textContent()}`);
        const bounds = await icon.boundingBox();
        assert(bounds && bounds.width >= 14 && bounds.height >= 14);
      }
      for (const id of ['message-date', 'message-time']) {
        const row = metadata.locator(`[data-setting-id="${id}"]`);
        const label = await row.locator('.weq-set-row-label').boundingBox();
        const toggle = await row.getByRole('switch').boundingBox();
        assert(label && toggle && label.x + label.width <= toggle.x);
      }
      if (width <= 760) {
        await page.getByRole('button', { name: '返回设置分类', exact: true }).click();
        await page.mouse.move(0, 0);
        const nav = page.locator('.weq-settings-nav');
        const styles = await nav.locator('button').evaluateAll((buttons) =>
          buttons.map((button) => {
            const style = getComputedStyle(button);
            return {
              background: style.backgroundColor,
              color: style.color,
              weight: style.fontWeight,
              border: style.borderBottomColor,
            };
          }),
        );
        assert(styles.length > 1);
        for (const style of styles) assert.deepEqual(style, styles[0]);
        if (output)
          await page.screenshot({ path: resolve(output, `categories-${width}-${theme}.png`) });
        await nav.getByRole('button', { name: '基础功能', exact: true }).click();
      } else {
        const active = page.locator('.weq-settings-nav-item.is-active');
        assert.equal(await active.count(), 1);
        assert.notEqual(
          await active.evaluate((button) => getComputedStyle(button).backgroundColor),
          await page
            .locator('.weq-settings-nav-item:not(.is-active)')
            .first()
            .evaluate((button) => getComputedStyle(button).backgroundColor),
        );
      }
      if (output)
        await page.screenshot({ path: resolve(output, `message-display-${width}-${theme}.png`) });
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-navigation.html`,
      );
      await page.evaluate((theme) => {
        window.settingsNavigationQa.theme.getState().setPreference(theme);
      }, theme);
      assert.deepEqual(await page.locator('.weq-settings-subnav-item').allTextContents(), [
        'Web 与 Remote',
        'MCP 服务器',
        'OneBot',
        'SSE 推送',
        'QQ 公众号推送',
      ]);
      assert.equal(await page.getByRole('button', { name: '后台服务', exact: true }).count(), 0);
      if (output)
        await page.screenshot({ path: resolve(output, `services-${width}-${theme}.png`) });
      const openCategory = async (label) => {
        if (width <= 760)
          await page.getByRole('button', { name: '返回设置分类', exact: true }).click();
        await page
          .locator('.weq-settings-nav')
          .getByRole('button', { name: label, exact: true })
          .click();
      };
      await openCategory('关于 WeQ');
      assert.deepEqual(await page.locator('.weq-settings-subnav-item').allTextContents(), [
        '版本与更新',
        'WeQ 账号管理',
        '配置备份与恢复',
        '日志与性能',
        '常见问题',
        '反馈',
      ]);
      await page.getByRole('button', { name: '反馈', exact: true }).click();
      const feedbackBody = page.getByRole('textbox', { name: '反馈正文 Markdown', exact: true });
      await feedbackBody.waitFor();
      assert((await feedbackBody.inputValue()).includes('## 错误的功能描述'));
      await page.getByRole('button', { name: '常见问题', exact: true }).click();
      assert.equal(await page.locator('.weq-message-modal').count(), 0);
      assert.equal(await page.locator('.weq-settings-body .weq-help-bug').count(), 0);
      await page.getByRole('button', { name: '反馈', exact: true }).click();
      const feedbackTitle = page.getByRole('textbox', { name: '反馈标题', exact: true });
      await feedbackTitle.fill('合成反馈标题');
      await page.getByRole('button', { name: '常见问题', exact: true }).click();
      await page.getByText('当前设置尚未保存', { exact: true }).waitFor();
      await page.getByRole('button', { name: '先保存', exact: true }).click();
      await feedbackTitle.fill('');
      if (output)
        await page.screenshot({ path: resolve(output, `feedback-${width}-${theme}.png`) });
      await page.getByRole('button', { name: '常见问题', exact: true }).click();
      assert.equal(await page.locator('.weq-message-modal').count(), 0);
      await page.getByRole('button', { name: '反馈', exact: true }).click();
      assert((await feedbackBody.inputValue()).includes('## 错误的功能描述'));
      await openCategory('凭据与数据');
      assert.deepEqual(await page.locator('.weq-settings-subnav-item').allTextContents(), [
        '监听与读取',
        '凭据管理',
        'QQ 登录记录与设备标识',
        '资源加载',
        '省流量模式',
        'QQ 资源管理',
        'QQ 数据库管理',
        'QQ 高级工具',
      ]);
      assert.deepEqual(
        await page.locator('.weq-settings-body .weq-set-card-title').allTextContents(),
        ['实时监听', '读取性能', 'QQ 在线能力', '长期授权'],
      );
      assert.equal(
        await page.getByRole('spinbutton', { name: '数据库读取并发上限', exact: true }).count(),
        1,
      );
      if (output) await page.screenshot({ path: resolve(output, `reading-${width}-${theme}.png`) });
      assert.equal(
        await page
          .locator('.weq-settings-subnav-item')
          .getByText('性能监视', { exact: true })
          .count(),
        0,
      );
      await page.getByRole('button', { name: 'QQ 高级工具', exact: true }).click();
      await page
        .locator('.weq-settings-body')
        .getByText('Protobuf / JCE 逆向', { exact: true })
        .waitFor();
      assert.equal(
        await page.locator('.weq-settings-body [data-setting-id="performance-monitor"]').count(),
        0,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `advanced-tools-${width}-${theme}.png`) });
      await page.getByRole('button', { name: 'QQ 登录记录与设备标识', exact: true }).click();
      const loginRecords = page.locator('.weq-settings-body [data-setting-id="qq-accounts"]');
      await loginRecords.scrollIntoViewIfNeeded();
      await loginRecords.getByText('合成登录账号', { exact: true }).waitFor();
      assert.equal(await loginRecords.locator('.weq-login-acc > .weq-set-card').count(), 2);
      assert.equal(
        await loginRecords.evaluate((node) => node.scrollWidth > node.clientWidth),
        false,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `login-records-${width}-${theme}.png`) });
      await page.getByRole('button', { name: '资源加载', exact: true }).click();
      await page.locator('.weq-settings-body [data-setting-id="external-chatpic"]').waitFor();
      const heading = page.locator('.weq-settings-body h3').first();
      assert.equal(await heading.textContent(), '资源加载');
      assert.equal(await page.locator('[data-setting-id="linked-resources"]').count(), 0);
      const directLabel = page.locator('.weq-settings-body .weq-set-row-label').first();
      const directToggle = page.getByRole('switch', { name: '优先直连 QQ 加载图片', exact: true });
      const labelBounds = await directLabel.boundingBox();
      const toggleBounds = await directToggle.boundingBox();
      assert(labelBounds && toggleBounds && labelBounds.x + labelBounds.width <= toggleBounds.x);
      if (output)
        await page.screenshot({ path: resolve(output, `resource-loading-${width}-${theme}.png`) });
      await page
        .locator('.weq-settings-body [data-setting-id="external-chatpic"]')
        .scrollIntoViewIfNeeded();
      if (output)
        await page.screenshot({ path: resolve(output, `external-chatpic-${width}-${theme}.png`) });
      await openCategory('WeQ 服务');
      await page.getByRole('button', { name: 'OneBot', exact: true }).click();
      await page.getByRole('button', { name: 'WebSocket', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '新建 WebSocket 服务器', exact: true });
      const name = editor.getByLabel('OneBot 服务器名称', { exact: true });
      await name.fill('未保存的连接');
      await page.keyboard.press('Escape');
      const modal = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true });
      await modal.waitFor();
      const bounds = await modal.boundingBox();
      assert(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= width + 1 &&
          bounds.y + bounds.height <= 845,
      );
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      await modal.getByRole('button', { name: '继续编辑', exact: true }).click();
      assert.equal(await name.inputValue(), '未保存的连接');
      await page.keyboard.press('Escape');
      await modal.getByRole('button', { name: '放弃修改', exact: true }).click();
      await editor.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '消息', exact: true }).click();
      await page.getByText('消息页面', { exact: true }).waitFor();
      assert.equal(await page.locator('.weq-settings-dialog').count(), 0);
      await page.getByRole('button', { name: '打开设置', exact: true }).click();
      assert.equal(await page.locator('.weq-editor-dialog').count(), 0);
      cases++;
    }
  }
  const remotePage = await browser.newPage({ userAgent: 'WeQRemote/settings-consolidation-qa' });
  remotePage.on('pageerror', (error) => errors.push(error.message));
  await remotePage.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  for (const width of [390, 1180]) {
    await remotePage.setViewportSize({ width, height: 844 });
    await remotePage.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-navigation.html`,
    );
    if (width <= 760)
      await remotePage.getByRole('button', { name: '返回设置分类', exact: true }).click();
    await remotePage
      .locator('.weq-settings-nav')
      .getByRole('button', { name: '凭据与数据', exact: true })
      .click();
    assert.deepEqual(await remotePage.locator('.weq-settings-subnav-item').allTextContents(), [
      '监听与读取',
      '凭据管理',
      '资源加载',
      '省流量模式',
      'QQ 资源管理',
      'QQ 数据库管理',
      'QQ 高级工具',
    ]);
    await remotePage.getByRole('button', { name: '资源加载', exact: true }).click();
    assert.equal(await remotePage.locator('[data-setting-id="external-chatpic"]').count(), 0);
    assert.equal(await remotePage.locator('[data-setting-id="linked-resources"]').count(), 0);
    await remotePage.getByRole('button', { name: 'QQ 高级工具', exact: true }).click();
    assert.equal(await remotePage.locator('[data-setting-id="qq-accounts"]').count(), 0);
    assert.equal(await remotePage.locator('[data-setting-id="reverse-tool"]').count(), 1);
    if (width <= 760)
      await remotePage.getByRole('button', { name: '返回设置分类', exact: true }).click();
    await remotePage
      .locator('.weq-settings-nav')
      .getByRole('button', { name: '关于 WeQ', exact: true })
      .click();
    assert.equal(
      await remotePage.getByRole('button', { name: 'WeQ 账号管理', exact: true }).count(),
      1,
    );
  }
  await remotePage.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, remoteCases: 2, errors }));
} finally {
  await browser?.close();
  await server.close();
}
