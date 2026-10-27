import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-clone-conversation'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/clone-conversation.stub.ts'),
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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/_avatar/') || url.pathname === '/_media/avatar')
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#287764"/><text x="20" y="27" text-anchor="middle" font-size="24" fill="white">W</text></svg>',
      });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const kind of ['persona', 'group']) {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/clone-conversation.html${kind === 'group' ? '?group' : ''}`,
    );
    await page.locator('.message-line.theirs').waitFor();
    for (const [theme, width, background, accent] of [
      ['light', 1280, 'plain', '#075c30'],
      ['dark', 1280, 'grid', '#fff3a1'],
      ['light', 390, 'paper', '#ffffff'],
      ['system', 390, 'dots', '#73cab8'],
    ]) {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.evaluate(
        ([theme, accent, background]) => window.cloneTheme(theme, accent, background),
        [theme, accent, background],
      );
      await page.waitForTimeout(100);
      const checks = await page.evaluate(() => {
        const bounds = (selector) => document.querySelector(selector).getBoundingClientRect();
        const header = bounds('.chat-header');
        const transcript = bounds('.message-scroll');
        const composer = bounds('.composer');
        const button = bounds('.composer-send');
        const editor = bounds('.composer-editor');
        return {
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
          regions:
            header.bottom <= transcript.top + 1 &&
            transcript.bottom <= composer.top + 1 &&
            composer.bottom <= innerHeight + 1,
          sendVisible:
            innerWidth <= 760 ||
            (button.width > 0 &&
              button.height > 0 &&
              button.right <= innerWidth &&
              button.bottom <= innerHeight),
          editorVisible: editor.width > 100 && editor.height >= 40,
          toolsFit: [...document.querySelectorAll('.chat-header button')].every((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width === 0 || rect.right <= innerWidth;
          }),
          avatar:
            !document.querySelector('.weq-asst-avatar') &&
            document.querySelector('.message-line.theirs .avatar img')?.src.includes('20001'),
          cloneBadge: [
            ...document.querySelectorAll('.message-avatar-button > .weq-virtual-avatar-badge'),
          ].every((badge) => {
            const rect = badge.getBoundingClientRect();
            const avatar = badge.parentElement.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.left >= avatar.left &&
              rect.right <= avatar.right + 4 &&
              rect.bottom <= avatar.bottom + 4
            );
          }),
          compactTime: bounds('.message-time-divider').width < 200,
        };
      });
      if (Object.values(checks).some((value) => !value))
        throw new Error(JSON.stringify({ kind, theme, width, checks }));
      for (const selector of [
        '.message-line.theirs .message-avatar-button',
        ...(kind === 'group' ? ['.message-line.theirs .weq-message-name-profile'] : []),
        '.weq-conversation-title-profile',
      ]) {
        await page.locator(selector).first().click();
        const card = page.getByRole('dialog', {
          name:
            selector === '.weq-conversation-title-profile' && kind === 'group'
              ? '群资料'
              : '用户资料',
          exact: true,
        });
        await card.waitFor();
        if (await card.locator('.weq-profile-expand').count())
          throw new Error('克隆名片仍有联系人展开入口');
        const groupCard = selector === '.weq-conversation-title-profile' && kind === 'group';
        if (!(await card.locator(`[aria-label="${groupCard ? '克隆群聊' : '克隆体'}"]`).count()))
          throw new Error('名片缺少克隆身份');
        if ((await card.textContent()).includes('克隆体'))
          throw new Error('仍显示多余克隆文字标签');
        if (!groupCard && /QQ|u_fixture|20001/.test(await card.textContent()))
          throw new Error('克隆名片仍展示源好友身份');
        const fits = await card.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight
          );
        });
        if (!fits) throw new Error('克隆名片溢出视口');
        if (output)
          await page.screenshot({
            path: resolve(
              output,
              `${kind}-${theme}-${width}-${selector === '.weq-conversation-title-profile' ? 'title-profile' : 'member-profile'}.png`,
            ),
          });
        if (!groupCard) {
          await card.getByRole('button', { name: '查看私聊', exact: true }).waitFor();
          await card.getByRole('button', { name: '预览私聊', exact: true }).click();
          await card.locator('.weq-private-preview-inline .message-line').first().waitFor();
          const previewFits = await card.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.left >= 0 &&
              rect.top >= 0 &&
              rect.right <= innerWidth &&
              rect.bottom <= innerHeight
            );
          });
          if (!previewFits) throw new Error('名片内私聊预览溢出');
          if (output)
            await page.screenshot({
              path: resolve(output, `${kind}-${theme}-${width}-private-preview.png`),
            });
          await card.getByRole('button', { name: '返回资料', exact: true }).click();
        } else {
          await card.getByRole('button', { name: '查看群聊消息', exact: true }).waitFor();
        }
        await card.getByRole('button', { name: '关闭', exact: true }).click();
      }
      if (kind === 'group') {
        if (width <= 760) await page.locator('.weq-mobile-group-info-trigger').click();
        await page.locator('.group-info-panel').waitFor({ state: 'visible' });
        const cloneRow = page.locator('.group-info-member-row').filter({ hasText: '合成好友' });
        if (
          !(await cloneRow.locator('[aria-label="克隆体"]').count()) ||
          (await cloneRow.textContent()).includes('克隆体')
        )
          throw new Error('群成员列表缺少克隆身份');
        await cloneRow.click({ button: 'right' });
        const memberMenu = page.locator('.avatar-context-menu');
        await memberMenu.getByRole('button', { name: '@Ta', exact: true }).waitFor();
        if (!(await memberMenu.getByRole('button', { name: '戳一戳', exact: true }).isDisabled()))
          throw new Error('克隆菜单开放了真实QQ操作');
        await memberMenu.getByRole('button', { name: '踢出群聊', exact: true }).waitFor();
        if (output)
          await page.screenshot({
            path: resolve(output, `${kind}-${theme}-${width}-member-menu.png`),
          });
        await page.keyboard.press('Escape');
        await page.locator('.group-info-member-row').filter({ hasText: '合成好友' }).click();
        await page.getByRole('dialog', { name: '用户资料', exact: true }).waitFor();
        await page
          .getByRole('dialog', { name: '用户资料', exact: true })
          .getByRole('button', { name: '关闭', exact: true })
          .click();
        if (width <= 760) await page.locator('.weq-mobile-group-info-trigger').click();
      }
      if (process.env.WEQ_PROFILE_ONLY) {
        results.push({ kind, theme, width, checks });
        continue;
      }
      await page.getByRole('button', { name: '切换会话', exact: true }).click();
      await page.getByRole('menu', { name: '会话列表' }).waitFor();
      const sessionLayer = await page.getByRole('menu', { name: '会话列表' }).evaluate((menu) => {
        const layer = menu.closest('.weq-overlay-layer');
        const rect = menu.querySelector('button').getBoundingClientRect();
        const cover = document.createElement('div');
        cover.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:1000`;
        document.body.append(cover);
        const top = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        const result = layer?.parentElement === document.body && menu.contains(top);
        cover.remove();
        return result;
      });
      if (!sessionLayer) throw new Error('会话选择仍被消息层遮挡');
      if (output)
        await page.screenshot({
          path: resolve(output, `${kind}-${theme}-${width}-session-menu.png`),
        });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '消息管理', exact: true }).click();
      await page.getByRole('menu', { name: '消息管理' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '搜索聊天记录', exact: true }).click();
      await page.locator('.weq-search-more-input').fill('合成消息');
      await page.locator('.weq-chatrecords-msg').first().click();
      await page.locator('.is-search-hit [data-generated-message-id="m1"]').waitFor();
      await page
        .locator('.composer-tools')
        .getByRole('button', { name: '表情', exact: true })
        .click();
      await page.locator('.emoji-panel [title="微笑"]').click();
      if (!(await page.locator('.composer-editor .composer-inline-emoji').count()))
        throw new Error('表情插入失败');
      if (await page.locator('.emoji-panel').isVisible())
        await page
          .locator('.composer-tools')
          .getByRole('button', { name: '表情', exact: true })
          .click();
      await page.locator('.composer-editor').fill('');
      await page
        .getByRole('button', {
          name: kind === 'group' ? '克隆群聊设置' : '克隆体设置',
          exact: true,
        })
        .click();
      await page.locator('.weq-conversation-settings-pane .weq-cvs-nav').waitFor();
      await page
        .locator('.weq-cvs-nav-item')
        .filter({ hasText: kind === 'group' ? '群聊管理' : '回复设置' })
        .click();
      const settingsFit = await page
        .locator('.weq-window-surface.weq-conversation-settings-pane')
        .evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight &&
            node.scrollWidth <= node.clientWidth
          );
        });
      if (!settingsFit) throw new Error('共用设置窗格溢出');
      if (output)
        await page.screenshot({ path: resolve(output, `${kind}-${theme}-${width}-settings.png`) });
      if (kind === 'group') {
        await page.locator('.weq-cvs-nav-item').filter({ hasText: '群成员' }).click();
        const memberPane = page.locator('.weq-conversation-settings-pane');
        const addMembers = memberPane.getByRole('button', { name: '添加成员', exact: true });
        await addMembers.click();
        const picker = page.getByRole('dialog', { name: '添加成员', exact: true });
        const existingMember = picker.getByRole('checkbox', { name: '合成好友', exact: true });
        if (!(await existingMember.isChecked()) || !(await existingMember.isDisabled()))
          throw new Error('已在群内的成员必须默认勾选并禁用');
        await picker.getByLabel('搜索克隆体', { exact: true }).fill('合成新');
        await picker.getByRole('checkbox', { name: '合成新成员', exact: true }).check();
        await picker.getByLabel('搜索克隆体', { exact: true }).fill('');
        if (output)
          await page.screenshot({
            path: resolve(output, `${kind}-${theme}-${width}-add-member.png`),
          });
        await picker.getByRole('button', { name: '添加（1）', exact: true }).click();
        await picker.waitFor({ state: 'hidden' });
        await memberPane
          .locator('.weq-group-member')
          .filter({ hasText: '合成新成员' })
          .getByTitle('移出当前群（保留克隆体）')
          .waitFor();
        await addMembers.click();
        const addedMember = picker.getByRole('checkbox', { name: '合成新成员', exact: true });
        if (!(await addedMember.isChecked()) || !(await addedMember.isDisabled()))
          throw new Error('刚添加的成员应勾选并禁用');
        await picker.getByRole('button', { name: '取消', exact: true }).click();
        await memberPane
          .locator('.weq-group-member')
          .filter({ hasText: '合成新成员' })
          .getByTitle('移出当前群（保留克隆体）')
          .click();
        await page.getByRole('button', { name: '移除', exact: true }).click();
        await page.getByTitle('设置克隆体 合成好友', { exact: true }).click();
        await page.getByText('以下修改影响此克隆体的所有私聊和群聊，不仅限于当前群。').waitFor();
        await page.locator('.weq-cvs-nav-item').filter({ hasText: '回复设置' }).click();
        if (output)
          await page.screenshot({
            path: resolve(output, `${kind}-${theme}-${width}-member-settings.png`),
          });
        await page.locator('.weq-cvs-close').click();
        await page
          .locator('.weq-cvs-nav-head strong')
          .filter({ hasText: '克隆群聊设置' })
          .waitFor();
      } else {
        for (const section of [
          '人格与画像',
          '回复设置',
          '语音',
          '对我的记忆',
          '导出与部署',
          '克隆体管理',
        ]) {
          await page.locator('.weq-cvs-nav-item').filter({ hasText: section }).click();
          const sectionFits = await page
            .locator('.weq-cvs-body-scroll')
            .evaluate((node) => node.scrollWidth <= node.clientWidth);
          if (!sectionFits) throw new Error(`设置分类横向溢出：${section} / ${theme} / ${width}`);
          if (
            output &&
            ((theme === 'dark' && width === 1280) || (theme === 'light' && width === 390))
          )
            await page.screenshot({
              path: resolve(output, `${kind}-${theme}-${width}-${section}.png`),
            });
        }
        const footerFit = await page.locator('.weq-persona-savebar').evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height >= 30 &&
            rect.bottom <= innerHeight &&
            rect.right <= innerWidth &&
            node.scrollWidth <= node.clientWidth
          );
        });
        if (!footerFit) throw new Error('统一保存栏溢出');
      }
      await page.locator('.weq-cvs-close').click();
      if (kind === 'group') {
        await page.locator('.composer-editor').fill('@');
        await page.locator('.mention-menu [role="option"]').filter({ hasText: '合成好友' }).click();
        if (!(await page.locator('.composer-editor').textContent()).includes('@合成好友'))
          throw new Error('提及插入失败');
        await page.locator('.composer-editor').fill('');
      }
      if (await page.locator('.chat-header [aria-label="多选消息"]').count())
        throw new Error('顶栏仍有独立多选入口');
      await page.locator('.composer-editor').fill('未发送草稿');
      await page
        .locator('[data-generated-message-id="m1"] .message-bubble')
        .click({ button: 'right' });
      await page.locator('.message-context-menu [title="多选"]').click();
      await page.locator('.composer.selection-mode .selection-bar').waitFor();
      if (await page.locator('.composer-editor').isVisible())
        throw new Error('多选时输入区没有让位');
      await page.locator('[data-generated-message-id="m2"]').click();
      await page.getByLabel('已选 2 条消息', { exact: true }).waitFor();
      for (const label of ['分析所选消息', '添加到素材库', '转发', '撤回所选消息', '删除']) {
        const action = page
          .locator('.selection-bar')
          .getByRole('button', { name: label, exact: true });
        if (!(await action.isVisible()) || !(await action.isDisabled()))
          throw new Error(`未适配的多选动作没有显示并置灰：${label}`);
        if ((await action.getAttribute('title')) !== '克隆会话暂不支持此功能')
          throw new Error(`多选动作缺少不可用说明：${label}`);
      }
      const selectionFit = await page.locator('.selection-bar').evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const pixel = (color) => {
          const ctx = document.createElement('canvas').getContext('2d');
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return `#${[...ctx.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')}`;
        };
        const mark = getComputedStyle(
          document.querySelector('.message-line.is-selected .message-select-mark'),
        );
        const count = getComputedStyle(node.querySelector('.selection-bar-count'));
        const composer = getComputedStyle(node.closest('.composer'));
        return (
          rect.bottom <= innerHeight &&
          rect.right <= innerWidth &&
          rect.height > 0 &&
          window.cloneContrast(pixel(mark.color), pixel(mark.backgroundColor)) >= 4.5 &&
          window.cloneContrast(pixel(count.color), pixel(composer.backgroundColor)) >= 4.5
        );
      });
      if (!selectionFit) throw new Error('多选操作栏溢出');
      if (output)
        await page.screenshot({ path: resolve(output, `${kind}-${theme}-${width}-selection.png`) });
      await page.getByRole('button', { name: '退出多选', exact: true }).click();
      await page.locator('.composer-editor').waitFor({ state: 'visible' });
      if ((await page.locator('.composer-editor').textContent()) !== '未发送草稿')
        throw new Error('退出多选后草稿丢失');
      await page.locator('.composer-editor').fill('');
      if (output) await page.screenshot({ path: resolve(output, `${kind}-${theme}-${width}.png`) });
      results.push({ kind, theme, width, checks });
    }
    await page.locator('.composer-editor').fill('共用页面发送');
    await page.locator('.composer-editor').press('Enter');
    await page
      .locator('.message-line.theirs[data-generated-message-id]')
      .filter({ hasText: '合成回复' })
      .last()
      .waitFor();
    const sent = await page.evaluate(() => window.cloneRequests());
    const expected = kind === 'group' ? 'sendAgentLabGroupMessage' : 'chatWithAgentLabPersona';
    if (!sent.some((call) => call.name === expected && call.input.text === '共用页面发送'))
      throw new Error('发送未适配到克隆后端');
    if (
      sent.some(
        (call) =>
          ![
            'sendAgentLabGroupMessage',
            'chatWithAgentLabPersona',
            'addAgentLabGroupMember',
            'removeAgentLabGroupMember',
          ].includes(call.name),
      )
    )
      throw new Error('克隆页面误调用未适配的写接口');
    if (
      kind === 'group' &&
      sent
        .filter((call) => call.name === 'addAgentLabGroupMember')
        .some((call) => call.input.groupId !== 'g' || call.input.personaId !== 'p2')
    )
      throw new Error('添加成员身份不正确');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
