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
const settingsNav = (page) => page.locator('.weq-settings-nav');
async function openSetting(page, name) {
  const back = page.getByRole('button', { name: '返回设置', exact: true });
  if (await back.isVisible()) await back.click();
  await settingsNav(page).getByRole('button', { name, exact: true }).click();
}

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
  page.setDefaultTimeout(8000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.clear());
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [1180, 390]) {
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
      const metadata = page.getByRole('group', { name: '消息元数据', exact: true });
      await metadata.waitFor();
      assert.deepEqual(await metadata.getByRole('button').allTextContents(), [
        '日期',
        '时间',
        '消息序号（seq）',
      ]);
      const headings = page.locator('.weq-set-card-head .weq-set-card-title');
      assert.equal(await headings.count(), 3);
      for (const heading of await headings.all()) {
        const icon = heading.locator('.weq-set-card-icon[aria-hidden] svg');
        assert.equal(await icon.count(), 1, `设置分组缺少图标：${await heading.textContent()}`);
        const bounds = await icon.boundingBox();
        assert(bounds && bounds.width >= 14 && bounds.height >= 14);
      }
      const metadataRow = page.locator('.weq-set-row').filter({ has: metadata });
      const label = await metadataRow.locator('.weq-set-row-label').boundingBox();
      const controls = await metadata.boundingBox();
      assert(
        label &&
          controls &&
          (label.x + label.width <= controls.x || label.y + label.height <= controls.y),
      );
      if (width <= 760) {
        await page.getByRole('button', { name: '返回设置', exact: true }).click();
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
          await page.screenshot({ path: resolve(output, `settings-list-${width}-${theme}.png`) });
        await nav.getByRole('button', { name: '消息显示', exact: true }).click();
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
      const nav = settingsNav(page);
      await page.locator('[data-settings-page="onebot"]').waitFor();
      assert.equal(
        await nav
          .getByRole('button', { name: '后台服务', exact: true, includeHidden: true })
          .count(),
        0,
      );
      assert.equal(await page.locator('.weq-settings-dialog > .weq-settings-close').count(), 0);
      if (width <= 760) await page.getByRole('button', { name: '返回设置', exact: true }).click();
      assert.deepEqual(await nav.getByRole('heading', { level: 3 }).allTextContents(), [
        '能力',
        '聊天',
        '更多',
        'AI',
        'QQ',
        '网络',
        '服务',
        '应用',
        '关于',
      ]);
      for (const [group, labels] of [
        ['能力', ['QQ 代理连接']],
        ['聊天', ['通话与录音', '识别与转写']],
        ['更多', ['联系人名片']],
        ['关于', ['版本与更新', '常见问题', '反馈']],
      ]) {
        const list = nav.getByRole('list', { name: group, exact: true });
        for (const name of labels) {
          assert.equal(await list.getByRole('button', { name, exact: true }).count(), 1);
        }
      }
      if (width <= 760) await openSetting(page, 'OneBot');
      if (width > 760) {
        const navBounds = await nav.boundingBox();
        const bodyBounds = await page.locator('.weq-settings-body').boundingBox();
        assert(navBounds && bodyBounds && navBounds.x + navBounds.width <= bodyBounds.x);
        assert.equal(navBounds.y, bodyBounds.y);
        assert(
          await nav
            .locator('.weq-settings-nav-groups')
            .evaluate((el) => el.scrollHeight > el.clientHeight),
        );
        const leftTitle = await nav
          .getByRole('heading', { name: '设置', exact: true })
          .boundingBox();
        const rightTitle = await page
          .locator('.weq-settings-body .weq-set-title')
          .first()
          .boundingBox();
        assert(leftTitle && rightTitle);
        const titleOffset =
          leftTitle.y + leftTitle.height / 2 - (rightTitle.y + rightTitle.height / 2);
        assert(Math.abs(titleOffset) <= 1, `左右设置标题相差 ${titleOffset}px`);
        const selected = nav.locator('[aria-current="page"]');
        assert.equal(await selected.textContent(), 'OneBot');
        await page.waitForFunction(
          () => {
            const entry = document.querySelector('.weq-settings-nav [aria-current="page"]');
            if (!entry) return false;
            const row = entry.getBoundingClientRect();
            const list = entry.closest('.weq-settings-nav-groups').getBoundingClientRect();
            return row.top >= list.top - 1 && row.bottom <= list.bottom + 1;
          },
          null,
          { timeout: 2000 },
        );
      }
      if (output)
        await page.screenshot({ path: resolve(output, `services-${width}-${theme}.png`) });
      await openSetting(page, '反馈');
      const feedbackBody = page.getByRole('textbox', { name: '反馈正文 Markdown', exact: true });
      await feedbackBody.waitFor();
      assert((await feedbackBody.inputValue()).includes('## 错误的功能描述'));
      await openSetting(page, '常见问题');
      assert.equal(await page.locator('.weq-message-modal').count(), 0);
      assert.equal(await page.locator('.weq-settings-body .weq-help-bug').count(), 0);
      await openSetting(page, '反馈');
      const feedbackTitle = page.getByRole('textbox', { name: '反馈标题', exact: true });
      await feedbackTitle.fill('合成反馈标题');
      if (width <= 760) await page.getByRole('button', { name: '返回设置', exact: true }).click();
      else await settingsNav(page).getByRole('button', { name: '常见问题', exact: true }).click();
      await page.getByText('当前设置尚未保存', { exact: true }).waitFor();
      await page.getByRole('button', { name: '先保存', exact: true }).click();
      await feedbackTitle.fill('');
      if (output)
        await page.screenshot({ path: resolve(output, `feedback-${width}-${theme}.png`) });
      await openSetting(page, '常见问题');
      assert.equal(await page.locator('.weq-message-modal').count(), 0);
      await openSetting(page, '反馈');
      assert((await feedbackBody.inputValue()).includes('## 错误的功能描述'));
      await openSetting(page, 'QQ 数据库管理');
      await page.locator('.weq-settings-body [data-setting-id="database-manager"]').waitFor();
      assert.equal(
        await page.getByRole('spinbutton', { name: '数据库读取并发上限', exact: true }).count(),
        1,
      );
      if (output) await page.screenshot({ path: resolve(output, `reading-${width}-${theme}.png`) });
      assert.equal(
        await page.locator('.weq-settings-nav-item').getByText('性能监视', { exact: true }).count(),
        0,
      );
      await openSetting(page, 'QQ 高级工具');
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
      await openSetting(page, 'QQ 登录管理');
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
      await openSetting(page, '资源加载');
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
      await openSetting(page, 'OneBot');
      await page
        .locator('.weq-set-card')
        .filter({ has: page.getByText('正向 WebSocket', { exact: true }) })
        .getByRole('button', { name: '新建', exact: true })
        .click();
      const editor = page.getByRole('dialog', { name: '新建正向 WebSocket', exact: true });
      const name = editor.getByLabel('网络名称', { exact: true });
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
      await modal.waitFor({ state: 'detached' });
      assert.equal(await name.inputValue(), '未保存的连接');
      await editor.getByRole('button', { name: '取消', exact: true }).click();
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
  remotePage.setDefaultTimeout(8000);
  remotePage.on('pageerror', (error) => errors.push(error.message));
  await remotePage.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const portrait = { width: 390, height: 844 };
  const landscape = { width: 844, height: 390 };
  await remotePage.setViewportSize(portrait);
  await remotePage.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-navigation.html?default=1`,
  );
  const defaultDetail = remotePage.locator('[data-settings-page="account"]');
  const backToSettings = remotePage.getByRole('button', { name: '返回设置', exact: true });
  await settingsNav(remotePage).waitFor();
  await defaultDetail.waitFor({ state: 'hidden' });
  await remotePage.setViewportSize(landscape);
  await defaultDetail.waitFor();
  await remotePage.setViewportSize(portrait);
  await backToSettings.waitFor();
  await defaultDetail.waitFor();
  await backToSettings.click();
  await settingsNav(remotePage).getByRole('button', { name: '消息显示', exact: true }).click();
  const messageDisplay = remotePage.getByRole('group', { name: '消息元数据', exact: true });
  await messageDisplay.waitFor();
  await remotePage.setViewportSize(landscape);
  await settingsNav(remotePage).waitFor();
  await messageDisplay.waitFor();
  await remotePage.setViewportSize(portrait);
  await backToSettings.waitFor();
  await messageDisplay.waitFor();
  for (const width of [1180, 390]) {
    await remotePage.setViewportSize({ width, height: 844 });
    await remotePage.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-navigation.html`,
    );
    await remotePage.locator('[data-settings-page="onebot"]').waitFor();
    const remoteLabels = await settingsNav(remotePage)
      .locator('.weq-settings-nav-label')
      .allTextContents();
    assert(!remoteLabels.includes('长期授权'));
    assert(!remoteLabels.includes('QQ 登录管理'));
    assert(remoteLabels.includes('WeQ 账号管理'));
    await openSetting(remotePage, '资源加载');
    assert.equal(await remotePage.locator('[data-setting-id="external-chatpic"]').count(), 0);
    assert.equal(await remotePage.locator('[data-setting-id="linked-resources"]').count(), 0);
    await openSetting(remotePage, 'QQ 高级工具');
    assert.equal(await remotePage.locator('[data-setting-id="qq-accounts"]').count(), 0);
    assert.equal(await remotePage.locator('[data-setting-id="reverse-tool"]').count(), 1);
  }
  await remotePage.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, remoteCases: 3, errors }));
} finally {
  await browser?.close();
  await server.close();
}
