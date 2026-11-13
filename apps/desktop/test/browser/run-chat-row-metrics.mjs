/**
 * 会话列表行几何/字号的机械审计（Lead）。
 *
 * 复用 conversation-views 的合成页面（真实 ConversationList + 真实样式），测量：
 *   - 行高、头像与正文基线、未读徽标与时间的右边缘是否对齐
 *   - 关键字号是否落在设计基线（行标题 14、预览 12、时间 11、徽标 ≥10）
 *   - 行内是否有横向溢出或重叠
 * 输出 JSON 便于对比修复前后。
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_CHAT_METRICS_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-chat-metrics'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/conversation-views.stub.ts'),
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/conversation-views.html`,
  );
  await page.locator('.conversation-row').first().waitFor();
  const metrics = await page.evaluate(() => {
    const round = (n) => Math.round(n * 100) / 100;
    const rows = [...document.querySelectorAll('.conversation-row')].slice(0, 12);
    const sample = (row) => {
      const r = row.getBoundingClientRect();
      const avatar = row.querySelector('.avatar')?.getBoundingClientRect();
      const name = row.querySelector('.row-main strong') ?? row.querySelector('strong');
      const nameBox = name?.getBoundingClientRect();
      const meta = row.querySelector('.row-meta')?.getBoundingClientRect();
      const unread = row.querySelector('.row-unread')?.getBoundingClientRect();
      const css = (el) => (el ? getComputedStyle(el) : null);
      return {
        rowHeight: round(r.height),
        paddingLeft: css(row)?.paddingLeft,
        paddingRight: css(row)?.paddingRight,
        avatarLeft: avatar ? round(avatar.left) : null,
        avatarRight: avatar ? round(avatar.right) : null,
        avatarWidth: avatar ? round(avatar.width) : null,
        nameLeft: nameBox ? round(nameBox.left) : null,
        nameFont: name ? css(name).fontSize : null,
        metaRight: meta ? round(meta.right) : null,
        metaFont: css(row.querySelector('.row-meta'))?.fontSize,
        metaBottom: meta ? round(meta.bottom) : null,
        unreadRight: unread ? round(unread.right) : null,
        unreadFont: css(row.querySelector('.row-unread'))?.fontSize,
        unreadTop: unread ? round(unread.top) : null,
        unreadSize: unread ? `${round(unread.width)}x${round(unread.height)}` : null,
        nameMetaGapBelowName: meta && nameBox ? round(meta.top - nameBox.top) : null,
        gapBetweenMetaAndUnread: meta && unread ? round(unread.top - meta.bottom) : null,
      };
    };
    const first = sample(rows[0]);
    const withUnread = rows.find((row) => row.querySelector('.row-unread'));
    return {
      first,
      withUnread: withUnread ? sample(withUnread) : null,
      rowCount: document.querySelectorAll('.conversation-row').length,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  console.log(JSON.stringify({ metrics, errors }, null, 2));
  if (output) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: resolve(output, 'conversation-rows-1280.png') });
  }
} finally {
  await browser?.close();
  await server.close();
}
