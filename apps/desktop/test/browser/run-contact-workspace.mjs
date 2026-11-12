import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stub = resolve(root, 'test/browser/contact-card.stub.ts');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_CONTACT_WORKSPACE_QA;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/hooks\/useQQWriteSession$/, replacement: stub },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
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
const report = [];
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (error) => errors.push(error.message));
  const image = await readFile(resolve(root, '../../resources/img/bot.png'));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (
      url.pathname === '/_media/dress' ||
      url.pathname === '/_media/qqshow' ||
      url.pathname === '/_avatar/fetch'
    )
      return route.fulfill({ contentType: 'image/png', body: image });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  if (output) await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-card.html?qqshow=1`;
  async function popover(title) {
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await dialog.waitFor();
    await dialog.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(await dialog.getAttribute('aria-modal'), null);
    assert.equal(
      await dialog.evaluate((node) => node.scrollWidth > node.clientWidth + 1),
      false,
      `${title} 不应横向溢出`,
    );
    assert.equal(
      await dialog.evaluate((node) => getComputedStyle(node.parentElement).backgroundColor),
      'rgba(0, 0, 0, 0)',
    );
    const bounds = await dialog.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(
      bounds.x >= 6 && bounds.x + bounds.width <= viewport.width - 6,
      JSON.stringify(bounds),
    );
    assert.ok(
      bounds.y >= 6 && bounds.y + bounds.height <= viewport.height - 6,
      JSON.stringify(bounds),
    );
    return dialog;
  }
  async function select(title) {
    await page
      .getByRole(page.viewportSize().width > 720 ? 'button' : 'tab', { name: title, exact: true })
      .click();
  }
  await page.goto(url);
  await page.getByRole('button', { name: '打开完整资料页', exact: true }).click();
  await page.locator('.weq-contact-workspace-v2').waitFor();
  assert.deepEqual(await page.locator('.weq-profile-directory button').allTextContents(), [
    '个人资料',
    '与我的关系',
    '群内资料',
    '个性展示',
  ]);
  assert.equal(await page.locator('.weq-contact-section-title').count(), 0);
  assert.equal(await page.getByRole('button', { name: '教育经历', exact: true }).count(), 0);
  assert.equal(
    await page
      .getByRole('button', { name: /资料变更记录|关系变更记录|所在群历史|个性展示变更记录/ })
      .count(),
    0,
  );
  const cold = await page.evaluate(() => window.contactCardQa.calls);
  assert.equal(
    cold.some(
      (call) => call.path.endsWith('fieldVersions') || call.path.endsWith('educationHistory'),
    ),
    false,
  );
  await page.getByTitle('查看教育经历', { exact: true }).click();
  await popover('教育经历');
  await page.getByRole('button', { name: '关闭资料详情', exact: true }).click();
  await page.getByRole('button', { name: '显示公司历史', exact: true }).click();
  const history = await popover('公司历史');
  await history.getByText('以前的工作室', { exact: true }).waitFor();
  assert.ok(
    (
      await page.evaluate(() =>
        window.contactCardQa.calls.filter((call) => call.path.endsWith('fieldVersions')),
      )
    ).every((call) => call.input.field === 'company'),
  );
  await history.getByRole('button', { name: '关闭历史', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '显示邮箱历史', exact: true }).count(), 0);
  await page.evaluate(() => {
    window.contactCardQa.profileEnabled = true;
    window.contactCardQa.notify();
  });
  await select('与我的关系');
  await page.getByRole('img', { name: '互动风格雷达' }).waitFor();
  assert.deepEqual(
    await page.locator('.weq-profile-section-block--prominent > header h3').allTextContents(),
    ['互动标识', '互动画像'],
  );
  assert.equal(await page.getByRole('button', { name: '互动画像', exact: true }).count(), 0);
  const icon = await page.locator('.weq-mutual-icon').first().boundingBox();
  assert.ok(icon.width <= 32 && icon.height <= 32);
  await page.getByRole('button', { name: '查看共同群列表', exact: true }).click();
  await popover('共同群 1');
  await page.locator('.weq-common-groups-close').click();
  await select('群内资料');
  await page.getByLabel('群聊', { exact: true }).selectOption('10004');
  await page.getByText('第二群昵称', { exact: true }).waitFor();
  assert.equal(
    await page
      .locator('.weq-profile-group-target')
      .getByRole('button', { name: '本群发言', exact: true })
      .count(),
    1,
  );
  assert.equal(
    await page
      .locator('.weq-profile-group-target')
      .getByRole('button', { name: '聊天分析', exact: true })
      .count(),
    1,
  );
  await page.getByRole('button', { name: '显示群昵称历史', exact: true }).click();
  await popover('群昵称历史');
  const groupHistory = await page.evaluate(() =>
    window.contactCardQa.calls.filter((call) => call.path.endsWith('fieldVersions')).at(-1),
  );
  assert.equal(groupHistory.input.entity, 'group:10004');
  assert.equal(groupHistory.input.field, 'card');
  assert.ok(groupHistory.input.memberUid);
  await page.getByRole('button', { name: '关闭历史', exact: true }).click();
  await page.getByRole('button', { name: '本群发言', exact: true }).click();
  await page.getByText('合成本群发言', { exact: true }).waitFor();
  assert.equal(await page.locator('.weq-contact-speech').count(), 0);
  assert.equal(await page.locator('.weq-profile-page-header').count(), 0);
  assert.equal(await page.locator('.weq-private-preview-inline .message-avatar-button').count(), 1);
  assert.equal(
    (
      await page.evaluate(() =>
        window.contactCardQa.calls
          .filter((call) => call.path === 'account.browseConversation')
          .at(-1),
      )
    ).input.conv,
    '10004',
  );
  await page.keyboard.press('Escape');
  await select('个性展示');
  await page
    .getByRole('img', { name: '当前 QQ 秀', exact: true })
    .evaluate((node) => node.decode());
  const fields = await page
    .locator('[aria-label="个性展示"][role="region"] [data-profile-field]')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.profileField));
  assert.ok(fields.indexOf('qqShow') >= 0 && fields.indexOf('qqShow') < fields.indexOf('labels'));
  assert.equal(await page.locator('.weq-contact-personality,.weq-perhome').count(), 0);
  assert.equal(await page.getByRole('button', { name: '个性装扮', exact: true }).count(), 0);
  const qq = await page.locator('.weq-contact-qqshow').evaluate((node) => {
    const row = node.closest('.weq-profile-data-row');
    const label = row.querySelector('.weq-profile-data-label').getBoundingClientRect();
    const image = node.getBoundingClientRect();
    const value = row.querySelector('.weq-profile-data-value').getBoundingClientRect();
    return {
      center: Math.abs(label.y + label.height / 2 - image.y - image.height / 2),
      left: Math.abs(value.x - image.x),
    };
  });
  assert.ok(qq.center < 1 && qq.left < 1, JSON.stringify(qq));
  await page.getByRole('button', { name: '查看 QQ 秀展柜', exact: true }).click();
  await popover('QQ 秀展柜');
  await page.keyboard.press('Escape');
  report.push({
    educationPopover: true,
    commonGroupsPopover: true,
    fieldHistory: true,
    groupContext: true,
    qqShowAlignment: qq,
    compactMarks: true,
  });
  for (const width of [1280, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.classList.toggle('dark', theme === 'dark');
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#b53049' : '#72cdb5',
        );
      }, theme);
      for (const title of ['个人资料', '与我的关系', '群内资料', '个性展示']) {
        await select(title);
        assert.equal(await page.locator('.weq-contact-section-title').count(), 0);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth > innerWidth ||
            [
              ...document.querySelectorAll('.weq-profile-workspace-body,.weq-profile-page-header'),
            ].some((node) => node.scrollWidth > node.clientWidth + 1),
        );
        assert.equal(overflow, false, `${width}/${theme}/${title} 不应溢出`);
        const identity = await page.locator('.weq-profile-page-identity').boundingBox();
        const actions = await page.locator('.weq-profile-page-actions').boundingBox();
        const narrow = await page
          .locator('.weq-contact-profile-v2')
          .evaluate((node) => node.clientWidth <= 560);
        assert.ok(
          narrow
            ? actions.y >= identity.y + identity.height + 8
            : actions.x >= identity.x + identity.width + 8,
        );
        if (output)
          await page.screenshot({ path: resolve(output, `${width}-${theme}-${title}.png`) });
        report.push({ width, theme, title, overflow });
      }
      for (const speech of [false, true]) {
        await select(speech ? '群内资料' : '个人资料');
        await page
          .getByRole('button', { name: speech ? '本群发言' : '预览消息', exact: true })
          .click();
        await page.getByRole('button', { name: '返回资料', exact: true }).waitFor();
        const pageBounds = await page.locator('.weq-contact-profile-content').boundingBox();
        const previewBounds = await page.locator('.weq-contact-chat-preview').boundingBox();
        assert.ok(
          Math.abs(pageBounds.y - previewBounds.y) <= 1 &&
            Math.abs(pageBounds.height - previewBounds.height) <= 1 &&
            Math.abs(pageBounds.width - previewBounds.width) <= 1,
          JSON.stringify({ pageBounds, previewBounds }),
        );
        assert.equal(await page.locator('.weq-profile-page-header').count(), 0);
        if (output)
          await page.screenshot({
            path: resolve(output, `${width}-${theme}-${speech ? 'speech' : 'preview'}.png`),
          });
        await page.getByRole('button', { name: '返回资料', exact: true }).click();
        await page.locator('.weq-profile-page-header').waitFor();
      }
      await select('个人资料');
      await page.getByTitle('查看教育经历', { exact: true }).click();
      await popover('教育经历');
      await page.keyboard.press('Escape');
      await select('与我的关系');
      await page.getByRole('button', { name: '查看共同群列表', exact: true }).click();
      await popover('共同群 1');
      await page.keyboard.press('Escape');
      await select('个人资料');
      await page.getByRole('button', { name: '显示公司历史', exact: true }).click();
      await popover('公司历史');
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}-field-history.png`) });
      await page.keyboard.press('Escape');
      await select('个性展示');
      await page.getByRole('button', { name: '查看 QQ 秀展柜', exact: true }).click();
      await popover('QQ 秀展柜');
      await page.keyboard.press('Escape');
    }
  }
  assert.deepEqual(errors, []);
  if (output)
    await writeFile(resolve(output, 'report.json'), JSON.stringify({ report, errors }, null, 2));
  console.log(JSON.stringify({ cases: report.length, errors }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (output && page) await page.screenshot({ path: resolve(output, 'failure.png') });
  console.error(JSON.stringify({ report, errors }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
