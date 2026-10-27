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
            button.width > 0 &&
            button.height > 0 &&
            button.right <= innerWidth &&
            button.bottom <= innerHeight,
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
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '消息管理', exact: true }).click();
      await page.getByRole('menu', { name: '消息管理' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '搜索聊天记录', exact: true }).click();
      await page.getByRole('textbox', { name: '搜索当前会话', exact: true }).fill('合成消息');
      await page.locator('.weq-clone-record-results > button').click();
      await page.locator('[data-generated-message-id="m1"].is-search-hit').waitFor();
      await page.getByRole('button', { name: '表情', exact: true }).click();
      await page.locator('.emoji-panel [title="微笑"]').click();
      if (!(await page.locator('.composer-editor').inputValue()).includes('/微笑'))
        throw new Error('表情插入失败');
      await page.locator('.composer-editor').fill('');
      if (kind === 'group') {
        await page.getByRole('button', { name: '提及成员', exact: true }).click();
        await page.locator('.weq-mention-opt').click();
        if (!(await page.locator('.composer-editor').inputValue()).includes('@合成好友'))
          throw new Error('提及插入失败');
        await page.locator('.composer-editor').fill('');
      }
      if (output) await page.screenshot({ path: resolve(output, `${kind}-${theme}-${width}.png`) });
      results.push({ kind, theme, width, checks });
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
