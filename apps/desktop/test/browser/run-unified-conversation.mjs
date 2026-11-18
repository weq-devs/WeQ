import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
if (output) await mkdir(output, { recursive: true });
const results = [];
let browser;
let server;
let page;
async function openAssistantSettings() {
  const direct = page.getByRole('button', { name: '助手设置', exact: true });
  if (await direct.count()) await direct.click();
  else {
    await page.getByRole('button', { name: '更多会话操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '助手设置', exact: true }).click();
  }
}
async function start(stub) {
  server = await createServer({
    configFile: false,
    root,
    optimizeDeps: { entries: [`test/browser/${stub}.html`] },
    cacheDir: resolve(root, `node_modules/.vite-unified-${stub}`),
    define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
    plugins: [react(), tailwind()],
    resolve: {
      alias: [
        { find: /^.*\/trpc\/client$/, replacement: resolve(root, `test/browser/${stub}.stub.ts`) },
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
  await server.listen();
  return `http://127.0.0.1:${server.httpServer.address().port}/test/browser`;
}
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/_avatar/') || url.pathname.startsWith('/_media/'))
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#287764"/></svg>',
      });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  let base = await start('unified-conversation');
  const kinds = process.env.WEQ_UNIFIED_CLONE_DEBUG
    ? []
    : process.env.WEQ_UNIFIED_KIND
      ? [process.env.WEQ_UNIFIED_KIND]
      : ['direct', 'group', 'dataline', 'official', 'service', 'guild', 'assistant'];
  if (kinds.includes('assistant')) {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${base}/unified-conversation.html?kind=assistant&empty`);
    const prompts = page.getByRole('region', { name: '推荐提示词' });
    await prompts.getByRole('button').first().waitFor();
    if ((await prompts.getByRole('button').count()) !== 4) throw new Error('推荐提示词未完整显示');
    await page.getByRole('button', { name: /^本会话模型/ }).click();
    await page.getByRole('menuitemradio', { name: /跟随默认/ }).waitFor();
    if (output) await page.screenshot({ path: resolve(output, 'assistant-empty-menu.png') });
    await page.keyboard.press('Escape');
    if (output) await page.screenshot({ path: resolve(output, 'assistant-empty.png') });
  }
  for (const kind of kinds)
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}/unified-conversation.html?kind=${kind}`);
        await page.locator('.chat-pane .chat-header').waitFor();
        if (kind === 'assistant') {
          const fonts = await page
            .locator('.weq-assistant-parameter-trigger')
            .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fontSize));
          if (fonts.length !== 2 || fonts[0] !== fonts[1])
            throw new Error(`助手模型与思考强度菜单字号不一致：${fonts.join(', ')}`);
          for (const name of ['新建会话', '清空当前对话']) {
            if (await page.getByRole('button', { name, exact: true }).count())
              throw new Error(`助手会话工具栏不应显示「${name}」`);
          }
        }
        await page.locator('.message-line').first().waitFor();
        await page.evaluate((value) => window.unifiedTheme(value), theme);
        await page.waitForTimeout(100);
        if (kind === 'assistant') {
          const tools = await page.locator('.composer-tools').evaluate((node) => {
            const rect = (selector) => node.querySelector(selector).getBoundingClientRect();
            const emoji = rect('[title="表情"]');
            const image = rect('[aria-label="添加图片"]');
            const parameters = rect('.weq-assistant-parameters');
            const model = rect('.weq-assistant-parameter-trigger');
            const toolbar = node.getBoundingClientRect();
            return {
              ordered: emoji.right <= image.left && image.right <= parameters.left,
              aligned:
                Math.abs(emoji.top + emoji.height / 2 - parameters.top - parameters.height / 2) < 2,
              right:
                Math.abs(
                  parameters.right -
                    toolbar.right +
                    Number.parseFloat(getComputedStyle(node).paddingRight),
                ) < 2,
              modelWidth: model.width,
            };
          });
          if (!tools.ordered || !tools.aligned || !tools.right || tools.modelWidth > 156)
            throw new Error(JSON.stringify({ kind, width, theme, tools }));
        }
        const layout = await page.evaluate(() => {
          const bounds = (selector) => document.querySelector(selector)?.getBoundingClientRect();
          const header = bounds('.chat-header');
          const timeline = bounds('.message-scroll');
          const composer = bounds('.composer');
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            ordered:
              header.bottom <= timeline.top + 1 &&
              (!composer || timeline.bottom <= composer.top + 1),
            visible: timeline.height > 100 && (!composer || composer.bottom <= innerHeight + 1),
            readonly: !document.querySelector('.composer-editor'),
          };
        });
        if (
          layout.overflow ||
          !layout.ordered ||
          !layout.visible ||
          layout.readonly !== ['official', 'service', 'guild'].includes(kind)
        )
          throw new Error(JSON.stringify({ kind, width, theme, layout }));
        if (kind === 'assistant') {
          await openAssistantSettings();
          for (const label of ['模型设置', '提示与工具', '运行中发送']) {
            await page.locator('.weq-cvs-nav-item').filter({ hasText: label }).click();
            const fit = await page.locator('.weq-cvs-dialog').evaluate((node) => {
              const rect = node.getBoundingClientRect();
              return (
                rect.left >= 0 &&
                rect.right <= innerWidth &&
                rect.bottom <= innerHeight &&
                node.scrollWidth <= node.clientWidth
              );
            });
            if (!fit) throw new Error(`设置分类溢出：${label}/${width}/${theme}`);
          }
          await page.locator('.weq-cvs-close').click();
          const send = async (text) => {
            const editor = page.locator('.composer-editor');
            await editor.fill(text);
            if (width < 620) await editor.press('Enter');
            else
              await page
                .getByRole('button', { name: '发送', exact: true })
                .filter({ visible: true })
                .click();
          };
          await send('合成新任务');
          const stop = page.getByRole('button', { name: '停止输出', exact: true });
          await stop.waitFor();
          if (
            !(await stop.evaluate((node) => {
              const bubble = node.previousElementSibling;
              if (!bubble?.classList.contains('message-bubble')) return false;
              const stopRect = node.getBoundingClientRect();
              const bubbleRect = bubble.querySelector('.message-content')?.getBoundingClientRect();
              return (
                bubbleRect &&
                stopRect.left >= bubbleRect.right - 1 &&
                Math.abs(stopRect.bottom - bubbleRect.bottom) < 3
              );
            }))
          )
            throw new Error('停止按钮没有与气泡外侧右下角对齐');
          if (output)
            await page.screenshot({
              path: resolve(output, `assistant-running-${theme}-${width}.png`),
            });
          if (await page.getByLabel('运行中发送方式', { exact: true }).count())
            throw new Error('输入区不应提供逐条发送模式切换');
          await openAssistantSettings();
          await page.locator('.weq-cvs-nav-item').filter({ hasText: '运行中发送' }).click();
          await page
            .getByRole('radiogroup', { name: '运行中默认发送方式', exact: true })
            .getByRole('radio', { name: '排队发送', exact: true })
            .click();
          await page.locator('.weq-cvs-close').click();
          await send('排队的问题');
          await page.getByLabel('待处理消息', { exact: true }).waitFor();
          await page.getByRole('button', { name: '停止输出', exact: true }).click();
          await page.getByRole('button', { name: '恢复输出', exact: true }).waitFor();
        }
        if (output)
          await page.screenshot({ path: resolve(output, `${kind}-${theme}-${width}.png`) });
        results.push({ kind, width, theme, layout });
      }
  await server.close();
  server = undefined;
  if (!process.env.WEQ_UNIFIED_KIND) {
    base = await start('clone-conversation');
    for (const cloneKind of ['clone', 'cloneGroup'])
      for (const width of [1440, 390])
        for (const theme of ['light', 'dark']) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(
            `${base}/clone-conversation.html${cloneKind === 'cloneGroup' ? '?group' : ''}`,
          );
          await page.locator('.message-line').first().waitFor();
          await page.evaluate((value) => window.cloneTheme(value, '#287764', 'plain'), theme);
          await page
            .locator('.composer-tools')
            .getByRole('button', { name: '表情', exact: true })
            .click();
          if (output)
            await page.screenshot({
              path: resolve(output, `${cloneKind}-emoji-${theme}-${width}.png`),
            });
          await page.locator('.emoji-panel [title="微笑"]').click({ timeout: 5000 });
          await page.locator('.composer-editor .composer-inline-emoji').waitFor();
          results.push({ kind: cloneKind, width, theme, emoji: true });
        }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ results, errors }, null, 2));
} catch (error) {
  if (output && page)
    await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
