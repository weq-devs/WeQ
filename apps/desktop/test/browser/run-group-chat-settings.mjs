import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const motionOnly = process.env.WEQ_GROUP_CHAT_MOTION === '1';
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/group-chat-settings-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  plugins: [react(), tailwind()],
  optimizeDeps: { entries: ['test/browser/group-chat-settings.html'] },
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-chat-settings.stub.ts'),
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
  browser = await (process.env.WEQ_GROUP_CHAT_BROWSER === 'webkit' ? webkit : chromium).launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const output = process.env.WEQ_GROUP_CHAT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const width of [390, 1200])
    for (const theme of motionOnly ? ['light'] : ['light', 'dark']) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        reducedMotion: 'reduce',
      });
      page.setDefaultNavigationTimeout(120000);
      page.setDefaultTimeout(60000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
      );
      const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-chat-settings.html`;
      const setTheme = () =>
        page.evaluate((theme) => {
          window.groupChatSettings.theme.getState().setPreference(theme);
          window.groupChatSettings.theme
            .getState()
            .setAccent(theme === 'dark' ? '#73cab8' : '#a53251');
          window.groupChatSettings.theme
            .getState()
            .setBackground(theme === 'dark' ? 'dots' : 'paper');
        }, theme);
      const preferences = (values) =>
        page.evaluate((values) => window.groupChatSettings.preferences(values), values);
      const quote = async () => {
        await page
          .locator('[data-message-id="quote-target"] .message-bubble')
          .click({ button: 'right' });
        await page.getByRole('menuitem', { name: '引用', exact: true }).click();
        await page.locator('.composer-quote').waitFor();
      };
      try {
        if (motionOnly) {
          await page.setDefaultTimeout(8000);
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await page.goto(`${url}?motion`);
          await checkMotion(page, width);
          if (width === 1200) {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.goto(`${url}?motion`);
            await checkMotion(page, width, true);
          }
          assert.deepEqual(errors, []);
          results.push({ width, motion: true, reducedMotion: width === 1200 });
          continue;
        }
        for (const section of ['display', 'sending']) {
          await page.goto(`${url}?settings=${section}`);
          await page.waitForFunction(() => window.groupChatSettings);
          await setTheme();
          const ids =
            section === 'display'
              ? ['group-message-name', 'group-message-level', 'group-message-title']
              : ['quote-auto-mention', 'quote-backspace-remove'];
          for (const id of ids) {
            const row = page.locator(`[data-setting-id="${id}"]`);
            await row.scrollIntoViewIfNeeded();
            const label = await row.locator('.weq-set-row-label').boundingBox();
            const toggle = await row.getByRole('switch').boundingBox();
            assert(label && toggle && label.x + label.width <= toggle.x + 1, `${id} 标签覆盖开关`);
            assert.equal(
              await row.getByRole('switch').getAttribute('aria-checked'),
              id === 'quote-auto-mention' ? 'false' : 'true',
            );
            if (output)
              await page.screenshot({ path: resolve(output, `${width}-${theme}-${id}.png`) });
          }
        }
        await page.goto(url);
        await page.waitForFunction(() => window.groupChatSettings);
        await setTheme();
        const heading = page.locator('[data-message-id="quote-target"] .weq-message-heading');
        await heading.waitFor();
        assert.match(await heading.textContent(), /本地群昵称/);
        assert.match(await heading.textContent(), /Lv42 · 测试专属头衔/);
        await preferences({ showGroupMemberName: false });
        await page.waitForFunction(
          () => !document.querySelector('.weq-message-heading').textContent.includes('本地群昵称'),
        );
        assert.match(await heading.textContent(), /Lv42 · 测试专属头衔/);
        await preferences({ showGroupMemberTitle: false });
        await page.waitForFunction(() =>
          document.querySelector('.weq-message-heading').textContent.includes('活跃成员'),
        );
        assert.doesNotMatch(await heading.textContent(), /测试专属头衔/);
        await preferences({
          showGroupMemberName: false,
          showGroupMemberLevel: false,
          showGroupMemberTitle: false,
        });
        await page.waitForFunction(() => !document.querySelector('.message-name'));
        await preferences({ autoMentionOnQuote: true });
        await quote();
        const editor = page.locator('.composer > .composer-editor');
        assert.equal(await editor.locator('[data-weq-at-uid="u_member"]').count(), 1);
        assert.equal(
          await editor.locator('[data-weq-at-uid="u_member"]').textContent(),
          '@公开昵称',
        );
        await quote();
        assert.equal(await editor.locator('[data-weq-at-uid="u_member"]').count(), 1);
        if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-quote.png`) });
        await editor.fill('全选删除的正文');
        await editor.selectText();
        await editor.press('Backspace');
        assert.equal(await page.locator('.composer-quote').count(), 1);
        await page.keyboard.down('Backspace');
        await page.keyboard.up('Backspace');
        assert.equal(await page.locator('.composer-quote').count(), 0);
        await preferences({ autoMentionOnQuote: false });
        await quote();
        await editor.fill('连续退格正文');
        await editor.selectText();
        await page.keyboard.down('Backspace');
        await page.keyboard.down('Backspace');
        await page.keyboard.up('Backspace');
        assert.equal(await page.locator('.composer-quote').count(), 1);
        await preferences({ backspaceRemovesQuote: false });
        await editor.press('Backspace');
        assert.equal(await page.locator('.composer-quote').count(), 1);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.deepEqual(errors, []);
        results.push({ width, theme, settings: 5, quote: true, independentDisplay: true });
      } catch (error) {
        if (errors.length) throw new Error(errors.join('\n'), { cause: error });
        throw error;
      } finally {
        await page.close();
      }
    }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

async function checkMotion(page, width, reduced = false) {
  const geometry = (action, selector, edge) =>
    action.evaluate(
      async (button, { selector, edge }) => {
        const element = document.querySelector(selector);
        const read = () => element.getBoundingClientRect()[edge];
        const values = [read()];
        const from = performance.now();
        button.click();
        while (performance.now() - from < 250) {
          await new Promise(requestAnimationFrame);
          values.push(read());
        }
        return values;
      },
      { selector, edge },
    );
  const smooth = (values, direction, label) => {
    const first = values[0] * direction;
    const last = values.at(-1) * direction;
    assert.ok(last - first > 8, label);
    const intermediate = values.filter(
      (x) => x * direction > first + 1 && x * direction < last - 1,
    );
    if (reduced) assert.equal(intermediate.length, 0, `${label}在减少动态效果时应立即到位`);
    else assert.ok(intermediate.length >= 2, `${label}应经过中间位置`);
  };
  const message = (id) => page.locator(`.message-line[data-message-id="${id}"]`);
  const menu = async (target, action) => {
    await target.click({ button: 'right' });
    const item = page.getByRole('menuitem', { name: action, exact: true });
    await item.waitFor();
    return item;
  };
  const quote = await menu(message('quote-target').locator('.message-content'), '引用');
  const compact = (await page.locator('html').getAttribute('data-weq-layout')) === 'single';
  assert.equal(compact, width < 760);
  const composerTarget = compact ? '.message-scroll' : '.composer-editor';
  const composerEdge = compact ? 'height' : 'top';
  const openingQuote = await geometry(quote, composerTarget, composerEdge);
  const quoteLayout = await page.locator('.chat-pane').evaluate((node) => ({
    rows: getComputedStyle(node).gridTemplateRows,
    quoteSpace: getComputedStyle(node).getPropertyValue('--weq-composer-quote-space'),
    composer: node.querySelector('.composer').className,
  }));
  smooth(
    openingQuote,
    compact ? -1 : 1,
    `添加引用 ${JSON.stringify({ openingQuote, quoteLayout })}`,
  );
  const editor = page.locator('.composer > .composer-editor');
  assert.equal(await editor.evaluate((node) => document.activeElement === node), true);
  const removeQuote = page.getByRole('button', { name: '取消引用', exact: true });
  smooth(await geometry(removeQuote, composerTarget, composerEdge), compact ? 1 : -1, '取消引用');
  await page.locator('.composer-quote').waitFor({ state: 'detached' });
  assert.equal(await editor.evaluate((node) => document.activeElement === node), true);
  if (compact) return;

  const collapse = page.getByRole('button', { name: '收起群聊侧栏' });
  smooth(await geometry(collapse, '.message-scroll', 'width'), 1, '收起群资料');
  await page.getByRole('complementary', { name: '群聊侧栏' }).waitFor({ state: 'hidden' });
  const expand = page.getByRole('button', { name: '展开群聊侧栏' });
  smooth(await geometry(expand, '.message-scroll', 'width'), -1, '展开群资料');
  await page.getByRole('complementary', { name: '群聊侧栏' }).waitFor();
  if (!reduced) {
    const reversed = await collapse.evaluate(async (button) => {
      const scroll = document.querySelector('.message-scroll');
      const openWidth = scroll.clientWidth;
      button.click();
      for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
      const closingWidth = scroll.clientWidth;
      button.click();
      const from = performance.now();
      while (performance.now() - from < 250) await new Promise(requestAnimationFrame);
      return [openWidth, closingWidth, scroll.clientWidth];
    });
    assert.ok(reversed[1] > reversed[0]);
    assert.equal(reversed[2], reversed[0]);
    assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
  }

  const following = '[data-message-id="following"].message-line';
  const transcript = message('voice').getByRole('group', { name: '转文字结果' });
  const hideTranscript = await menu(transcript, '收起');
  smooth(await geometry(hideTranscript, following, 'top'), -1, '收起转写结果');
  const showTranscript = message('voice').getByTitle('展开转文字结果');
  smooth(await geometry(showTranscript, following, 'top'), 1, '重新展开转写结果');

  await message('quote-target').locator('.message-content').click({ button: 'right' });
  const translate = page.getByText('翻译成中文', { exact: true });
  smooth(await geometry(translate, following, 'top'), 1, '展开译文');
  const navigate = (action) =>
    page.locator(following).evaluate(async (element, action) => {
      const positions = [element.getBoundingClientRect().top];
      if (action === 'translation')
        window.groupChatSettings.resolveTranslation('需要逐行展开的模拟翻译结果。'.repeat(8));
      else window.groupChatSettings.setOptimistic(action);
      const from = performance.now();
      while (performance.now() - from < 250) {
        await new Promise(requestAnimationFrame);
        positions.push(element.getBoundingClientRect().top);
      }
      return positions;
    }, action);
  smooth(await navigate('translation'), 1, '译文由短变长');
  const hideTranslation = await menu(
    message('quote-target').getByRole('group', { name: '译文' }),
    '收起',
  );
  smooth(await geometry(hideTranslation, following, 'top'), -1, '收起译文');

  smooth(await navigate('failed'), 1, '显示发送失败');
  await message('outgoing').getByText('发送失败').waitFor();
  smooth(await navigate('sending'), -1, '移除发送失败');
  smooth(await navigate('sent'), 1, '显示可能未送达');
  await message('outgoing').getByText('可能未送达').waitFor();
}
