import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { eventTimeFormatter } from '../../../../packages/time/src/index.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-group-card-refactor'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-card-refactor.stub.ts'),
      },
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
const output = process.env.WEQ_GROUP_CARD_ARTIFACTS;
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    ['127.0.0.1'].includes(new URL(route.request().url()).hostname) ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-card-refactor.html`,
  );
  await page.getByText('我的群备注', { exact: true }).waitFor();
  await page.waitForFunction(() => window.groupCardFirstPaint);
  const firstPaint = await page.evaluate(() => window.groupCardFirstPaint);
  assert.equal(firstPaint.name, '原来的群名称');
  assert.equal(firstPaint.hasDescription, true);
  assert.equal(firstPaint.avatars, 0);
  assert.equal(await page.getByText('只在完整资料显示的公告', { exact: true }).count(), 0);
  assert.equal(await page.locator('.weq-group-preview-avatars').count(), 0);
  const calls = await page.evaluate(() => window.groupCardCalls);
  assert.equal(calls.includes('account.getGroupExtendedProfile'), true);
  await page.getByText(eventTimeFormatter.format(1704038407 * 1000), { exact: true }).waitFor();
  assert.equal(await page.getByText('我的入群时间', { exact: true }).count(), 1);
  assert.equal(calls.includes('account.listGroupMembers'), false);
  assert.equal(calls.includes('account.groupMemberPreview'), false);
  assert.equal(await page.locator('.weq-group-quick-identity .weq-profile-id').count(), 0);
  assert.deepEqual(
    await page.locator('.weq-group-quick-card .weq-profile-subtitle').allTextContents(),
    ['群资料', '成员'],
  );
  assert.equal(
    await page
      .locator('.weq-group-quick-card .weq-group-tags')
      .evaluate((element) => getComputedStyle(element).borderTopWidth),
    '0px',
  );
  assert.deepEqual(
    (await page.locator('.weq-group-quick-card .weq-profile-data-label').allTextContents()).slice(
      -3,
    ),
    ['群容量', '群成员数', '群内好友数'],
  );
  const cardActions = page.locator('.weq-group-quick-card .weq-profile-card-actions');
  assert.equal(await cardActions.locator('button.weq-contact-secondary').count(), 2);
  assert.equal(await cardActions.locator('.weq-contact-primary').count(), 0);
  await page.getByRole('button', { name: '展开', exact: true }).click();
  assert.equal(await page.locator('.weq-group-description .is-clamped').count(), 0);
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '查看群成员列表', exact: true }).click();
  const memberList = page.getByRole('dialog', { name: '群成员', exact: true });
  await memberList.getByRole('button', { name: '查看 昵称 1 的资料', exact: true }).waitFor();
  await memberList.locator('ul').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await memberList
    .getByRole('button', { name: '查看 昵称 110 的资料', exact: true })
    .waitFor({ state: 'attached' });
  assert.ok((await memberList.boundingBox()).height <= 481);
  await memberList.getByRole('searchbox', { name: '搜索群成员' }).fill('成员3');
  await memberList.getByRole('button', { name: '查看 昵称 3 的资料', exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll('.weq-group-card-member-list li').length === 1,
  );
  await memberList.getByRole('searchbox', { name: '搜索群成员' }).fill('');
  await memberList.getByRole('button', { name: '查看 昵称 1 的资料', exact: true }).click();
  await page.getByRole('dialog', { name: '用户资料', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '用户资料', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('dialog', { name: '群资料', exact: true }).waitFor();
  await memberList.waitFor();
  await page.keyboard.press('Escape');
  await memberList.waitFor({ state: 'detached' });
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        window.groupCardQa.theme.getState().setPreference(theme);
        window.groupCardQa.theme.getState().setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
      }, theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const bounds = await page
        .locator('.weq-group-quick-card')
        .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
      assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
      const buttons = await cardActions.locator('button').evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return {
            height: element.getBoundingClientRect().height,
            background: style.backgroundColor,
            border: style.border,
            color: style.color,
            padding: style.padding,
            radius: style.borderRadius,
          };
        }),
      );
      assert.deepEqual(buttons[0], buttons[1]);
      assert.equal(await cardActions.evaluate((element) => getComputedStyle(element).gap), '8px');
      if (output) await page.screenshot({ path: resolve(output, `card-${width}-${theme}.png`) });
      await page.getByRole('button', { name: '查看群内好友列表', exact: true }).click();
      const friends = page.getByRole('dialog', { name: '群内好友', exact: true });
      await friends.getByRole('button', { name: '查看 昵称 108 的资料', exact: true }).waitFor();
      assert.equal(await friends.locator('li').count(), 1);
      assert.equal(await friends.locator('li').first().textContent(), '昵称 10810108');
      const popup = await friends.boundingBox();
      assert.ok(popup.x >= 0 && popup.x + popup.width <= width + 1);
      if (output) await page.screenshot({ path: resolve(output, `friends-${width}-${theme}.png`) });
      await friends.getByRole('searchbox', { name: '搜索群内好友' }).fill('没有匹配');
      await friends.getByText('没有匹配的成员', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await friends.waitFor({ state: 'detached' });
    }
  await page.evaluate(() => window.groupCardQa.short());
  await page.waitForFunction(
    () => document.querySelector('.weq-group-description p')?.textContent === '短简介',
  );
  assert.equal(await page.getByRole('button', { name: '展开', exact: true }).count(), 0);
  await page.evaluate(() => window.groupCardQa.admin());
  await page.getByRole('button', { name: '编辑群名称', exact: true }).waitFor();
  assert.equal(await page.locator('.weq-group-quick-card .weq-profile-name').count(), 1);
  if (output) await page.screenshot({ path: resolve(output, 'card-admin-320-dark.png') });
  await page.getByRole('button', { name: '编辑群名称', exact: true }).click();
  const nameInput = page.getByRole('textbox', { name: '群名称', exact: true });
  await nameInput.waitFor();
  if (output) await page.screenshot({ path: resolve(output, 'card-edit-320-dark.png') });
  const editorBounds = await nameInput.evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    parent: el.parentElement?.getBoundingClientRect().width,
    form: el.closest('form')?.getBoundingClientRect().width,
  }));
  assert.ok(editorBounds.width >= 100, JSON.stringify(editorBounds));
  assert.equal(
    await page.locator('.weq-group-quick-card').evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  if (output) await page.screenshot({ path: resolve(output, 'card-edit-320-dark.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '群资料', exact: true }).waitFor();
  assert.equal(await nameInput.count(), 0);
  await page.getByRole('button', { name: '编辑群名称', exact: true }).click();
  await nameInput.fill('修改后的群名称');
  await page.getByRole('button', { name: '保存群名称', exact: true }).click();
  await page
    .getByRole('button', { name: '编辑群名称', exact: true })
    .filter({ hasText: '修改后的群名称' })
    .waitFor();
  await page.evaluate(() => window.groupCardQa.long());
  await page.waitForFunction(
    () => document.querySelector('.weq-profile-name')?.textContent.length >= 60,
  );
  assert.equal(
    await page.locator('.weq-group-quick-card').evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  if (output) await page.screenshot({ path: resolve(output, 'card-long-320-dark.png') });
  await page.evaluate(() => {
    window.groupCardQa.normal();
    window.groupCardQa.empty();
  });
  await page.waitForFunction(() => !document.querySelector('.weq-group-description'));
  assert.equal(await page.getByRole('heading', { name: '群资料', exact: true }).count(), 1);
  await page.evaluate(() => window.groupCardQa.normal());
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.getByRole('button', { name: '打开完整群资料', exact: true }).first().click();
  await page.locator('.weq-group-profile-columns').waitFor();
  await page.waitForFunction(() => window.groupFullFirstPaint);
  const fullFirstPaint = await page.evaluate(() => window.groupFullFirstPaint);
  assert.equal(fullFirstPaint.name, '原来的群名称');
  assert.equal(fullFirstPaint.hasInformation, true);
  assert.equal(fullFirstPaint.members, 0);
  assert.equal(await page.getByRole('navigation', { name: '群详情分区' }).count(), 0);
  await page.getByText('105 人', { exact: true }).waitFor();
  assert.equal(await page.locator('.weq-profile-tech').count(), 0);
  assert.equal(await page.locator('.weq-group-profile-information .is-clamped').count(), 0);
  await page.getByRole('button', { name: '查看群成员列表', exact: true }).click();
  assert.equal(
    await page
      .getByRole('textbox', { name: '搜索群成员' })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.getByRole('textbox', { name: '搜索群成员' }).fill('成员3');
  await page.waitForFunction(() => window.groupCardCalls.includes('account.searchGroupMembers'));
  await page.getByText('成员 3', { exact: true }).last().waitFor();
  assert.equal(await page.locator('.group-info-member-row:visible').count(), 1);
  const search = page.getByRole('textbox', { name: '搜索群成员' });
  const memberPanel = page.locator('.weq-group-profile-members');
  await page.getByRole('button', { name: '预览消息', exact: true }).click();
  await page.getByRole('button', { name: '返回群资料', exact: true }).click();
  assert.equal(await search.inputValue(), '成员3');
  const settings = page.getByRole('button', { name: '会话设置', exact: true });
  const toolbar = page.locator('.weq-profile-page-toolbar');
  assert.deepEqual(
    await toolbar
      .locator('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    ['会话设置', '关闭群资料'],
  );
  await settings.click();
  const pane = page.locator('.weq-conversation-settings-pane');
  await pane.waitFor();
  assert.equal(await pane.locator('.weq-cvs-nav-item.is-on').textContent(), '会话偏好');
  assert.equal(await pane.getByText('群备注', { exact: true }).count(), 0);
  await pane.getByRole('button', { name: '群管理', exact: true }).click();
  await pane.getByText('其他操作', { exact: true }).waitFor();
  assert.equal(await pane.getByText('群名称', { exact: true }).count(), 0);
  assert.equal(await pane.getByRole('button', { name: '更换群头像', exact: true }).count(), 0);
  await pane.getByRole('button', { name: '查看群资料', exact: true }).click();
  await pane.waitFor({ state: 'detached' });
  assert.equal(await search.inputValue(), '成员3');
  await search.fill('');
  await memberPanel.locator('.group-info-member-row').first().waitFor();
  for (const label of ['公告', '待办', '相册', '文件', '精华', '打卡'])
    assert.equal(
      await page.getByRole('button', { name: `查看群${label}`, exact: true }).count(),
      0,
    );
  assert.deepEqual(await page.locator('.weq-profile-page-actions button').allTextContents(), [
    '打开会话',
    '预览消息',
  ]);
  for (const width of [1180, 800, 600, 561, 560, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        window.groupCardQa.theme.getState().setPreference(theme);
      }, theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      await page.evaluate(
        (theme) =>
          window.groupCardQa.theme.getState().setAccent(theme === 'light' ? '#075c30' : '#fff3a1'),
        theme,
      );
      await page.getByText('我的入群时间', { exact: true }).first().waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.ok(
        await page
          .locator('.weq-group-page')
          .evaluate((element) => element.getBoundingClientRect().width >= innerWidth - 32),
      );
      assert.equal(
        await page
          .locator('.weq-group-page')
          .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
        false,
      );
      const alignment = await page.evaluate(() => {
        const bounds = (selector) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return { x: box.x, width: box.width };
        };
        return {
          identity: bounds('.weq-profile-page-identity'),
          actions: bounds('.weq-profile-page-actions'),
          information: bounds('.weq-group-profile-information'),
          members: bounds('.weq-group-profile-members'),
          memberSearch: bounds('.weq-group-profile-members .group-info-member-search'),
          memberHeading: bounds('.weq-group-profile-members .group-info-heading'),
        };
      });
      assert.deepEqual(alignment.identity, alignment.information);
      assert.deepEqual(alignment.actions, alignment.members);
      assert.deepEqual(alignment.actions, alignment.memberSearch);
      assert.deepEqual(alignment.actions, alignment.memberHeading);
      if (width > 560) {
        const information = page.locator('.weq-group-profile-information');
        const before = await memberPanel.boundingBox();
        await information.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const after = await memberPanel.boundingBox();
        assert.equal(before.y, after.y);
        assert.ok(after.height > 200);
        await information.evaluate((element) => {
          element.scrollTop = 0;
        });
      }
      assert.equal(
        await memberPanel
          .locator('.group-info-panel')
          .evaluate((element) => getComputedStyle(element).boxShadow),
        'none',
      );
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
    }
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.groupCardQa.long());
  await page.waitForFunction(
    () => document.querySelector('.weq-profile-name')?.textContent.length >= 60,
  );
  await page.setViewportSize({ width: 320, height: 740 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok(
    await page
      .locator('.weq-group-profile-information')
      .evaluate((element) => element.getBoundingClientRect().height > 48),
  );
  if (output) await page.screenshot({ path: resolve(output, '320-dark-long.png') });
  const result = {
    firstPaint,
    fullFirstPaint,
    checks: [
      'identity-first',
      'quick-card-sections-only',
      'matching-outlined-actions-and-shared-spacing',
      'short-description-no-toggle',
      'admin-title-edit-without-duplicate',
      'narrow-title-editor-save-and-escape',
      'member-and-friend-count-popovers',
      'member-list-scroll-pagination-and-search',
      'friend-on-second-page',
      'tags-without-management-border',
      'six-quick-card-theme-captures',
      'no-preview-avatar-or-preview-request',
      'no-heavy-card-requests',
      'nested-return',
      'continuous-profile-without-directory',
      'no-group-feature-button-grid',
      'upper-and-lower-column-alignment',
      'profile-settings-button-before-close',
      'settings-and-preview-return-preserve-search',
      'independent-member-scrolling',
      'shared-self-join-time-in-card-and-profile',
      'member-search',
      'fourteen-responsive-theme-captures',
      'long-names-remain-navigable',
    ],
    calls: await page.evaluate(() => window.groupCardCalls),
    errors,
  };
  if (output) await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await server.close();
}
