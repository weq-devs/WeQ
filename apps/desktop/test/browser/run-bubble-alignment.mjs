import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const playwright = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const { chromium } = playwright.default ?? playwright;
const server = await createServer({
  configFile: false,
  root: resolve(root, 'src/renderer'),
  cacheDir: resolve(root, 'node_modules/.vite-bubble-alignment'),
  optimizeDeps: { noDiscovery: true, entries: [], include: ['zustand'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
// 老款 272 的真实几何；无需真实账号、数据库或网络素材。
const skin = {
  itemId: 272,
  slice: { left: 59, right: 61, top: 53, bottom: 51 },
  imageSize: { w: 128, h: 112 },
  textColor: 'rgb(237 141 38)',
  localFile: null,
};
const css = (
  await Promise.all(
    ['chat.css', 'emoji.css'].map((name) =>
      readFile(resolve(root, 'src/renderer/src/im-template/styles', name), 'utf8'),
    ),
  )
).join('\n');
const image = process.env.WEQ_BUBBLE_IMAGE
  ? `data:image/png;base64,${(await readFile(process.env.WEQ_BUBBLE_IMAGE)).toString('base64')}`
  : null;
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  for (const width of [390, 1200]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.route(`${origin}/`, (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><meta charset="utf-8">',
          }),
        );
        await page.goto(origin);
        await page.addStyleTag({ content: css });
        await page.evaluate(
          async ({ skin, theme, image }) => {
            const { applyDressSkin } = await import('/src/lib/dressSkin.ts');
            const { injectBubbleCss } = await import('/src/lib/msgDecorationStyle.ts');
            injectBubbleCss(skin);
            applyDressSkin({ ...skin, itemId: 273 }, null, null, 'all');
            const activeStyle = document.getElementById('weq-dress-skin');
            activeStyle.textContent = activeStyle.textContent.replaceAll(
              '.message-line',
              '.active-scope .message-line',
            );
            if (image) {
              for (const style of document.querySelectorAll('style')) {
                style.textContent = style.textContent.replaceAll(
                  /url\("[^"]*dressbubble[^"]*"\)/g,
                  `url("${image}")`,
                );
              }
            }
            document.documentElement.dataset.theme = theme;
            document.body.style.cssText = `font-family:Arial,sans-serif;--weq-fg-primary:${theme === 'dark' ? '#eee' : '#111'};background:${theme === 'dark' ? '#222' : '#f7f7f7'}`;
            for (const path of ['message', 'active']) {
              for (const side of ['mine', 'theirs', 'forward']) {
                for (const text of [
                  '咦',
                  '第一行较长\n短',
                  '一段用于检查窄屏自动换行且不应超出气泡的长文本'.repeat(4),
                ]) {
                  const line = document.createElement('div');
                  line.className = side === 'forward' ? 'weq-forward-row' : `message-line ${side}`;
                  if (path === 'message') line.dataset.bubble = '272';
                  else if (side === 'forward') continue;
                  line.innerHTML =
                    '<div class="message-content qq-message-inline"><div class="qq-message-body"></div></div>';
                  line.querySelector('.qq-message-body').textContent = text;
                  line.style.cssText = 'max-width:260px;margin:12px;';
                  const scope = document.createElement('section');
                  if (path === 'active') scope.className = 'active-scope';
                  scope.append(line);
                  document.body.append(scope);
                }
              }
            }
          },
          { skin, theme, image },
        );
        const metrics = await page.locator('.message-content').evaluateAll((nodes) =>
          nodes.map((node) => {
            const body = node.querySelector('.qq-message-body');
            const box = node.getBoundingClientRect();
            const rect = body.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(body);
            const lines = [...range.getClientRects()].filter((line) => line.width > 0);
            return {
              text: body.textContent,
              dx: rect.x + rect.width / 2 - box.x - box.width / 2,
              dy: rect.y + rect.height / 2 - box.y - box.height / 2,
              textDx: lines[0].x + lines[0].width / 2 - box.x - box.width / 2,
              overflow: node.scrollWidth - node.clientWidth,
              lineStarts: lines.map((line) => line.x),
            };
          }),
        );
        for (const m of metrics) {
          assert.ok(Math.abs(m.dx) < 0.1, JSON.stringify(m));
          if (m.text === '咦') assert.ok(Math.abs(m.textDx) < 0.1, JSON.stringify(m));
          assert.ok(Math.abs(m.dy) < 0.1, JSON.stringify(m));
          assert.ok(m.overflow <= 1, JSON.stringify(m));
          if (m.text !== '咦') assert.ok(m.lineStarts.length >= 2, JSON.stringify(m));
          assert.ok(
            m.lineStarts.every((x) => Math.abs(x - m.lineStarts[0]) < 0.1),
            JSON.stringify(m),
          );
        }
        if (process.env.WEQ_BUBBLE_ARTIFACTS) {
          await mkdir(process.env.WEQ_BUBBLE_ARTIFACTS, { recursive: true });
          await page.screenshot({
            path: resolve(process.env.WEQ_BUBBLE_ARTIFACTS, `${width}-${theme}.png`),
          });
        }
        console.log(JSON.stringify({ width, theme, bubbles: metrics.length, passed: true }));
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
