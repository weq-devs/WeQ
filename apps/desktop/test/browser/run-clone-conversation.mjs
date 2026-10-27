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
          cloneBadge: Boolean(document.querySelector('.message-avatar-wrap [aria-label="克隆体"]')),
          compactTime: bounds('.message-time-divider').width < 200,
        };
      });
      if (Object.values(checks).some((value) => !value))
        throw new Error(JSON.stringify({ kind, theme, width, checks }));
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
        .filter({ hasText: kind === 'group' ? '群聊管理' : '额外提示' })
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
        (call) => !['sendAgentLabGroupMessage', 'chatWithAgentLabPersona'].includes(call.name),
      )
    )
      throw new Error('克隆页面误调用未适配的写接口');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
