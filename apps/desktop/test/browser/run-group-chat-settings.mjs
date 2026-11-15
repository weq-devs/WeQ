import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
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
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
  const output = process.env.WEQ_GROUP_CHAT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const width of [390, 1200])
    for (const theme of ['light', 'dark']) {
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
