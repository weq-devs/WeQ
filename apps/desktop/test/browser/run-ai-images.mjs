import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAANklEQVRIie3WuQkAQAwDwem/aV0VhgsWnAuMnjVOTwJ6kVy0gqaqWG2qwVmTKaoQeAkdfU3XDzLD/C7nwdQVAAAAAElFTkSuQmCC',
  'base64',
);
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-ai-images'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/ai-images.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  optimizeDeps: { entries: ['test/browser/ai-images.html'], force: true },
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
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
    if (error.message.includes('worker_threads')) {
      const visited = new Set();
      const trace = (module, depth = 0) => {
        if (!module || visited.has(module.id) || depth > 12) return;
        visited.add(module.id);
        console.error(' '.repeat(depth), module.id);
        for (const importer of module.importers) trace(importer, depth + 1);
      };
      for (const module of server.moduleGraph.getModulesByFile(
        resolve(root, '../../packages/service/src/index.ts'),
      ) ?? [])
        trace(module);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/_media/ai-image')
      return route.fulfill({ contentType: 'image/png', body: png });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  const widths = process.env.WEQ_AI_WIDTHS
    ? process.env.WEQ_AI_WIDTHS.split(',').map(Number)
    : [1280, 390, 320];
  const surfaces = process.env.WEQ_AI_SURFACES
    ? process.env.WEQ_AI_SURFACES.split(',')
    : ['settings', 'assistant', 'clone', 'group', 'new-clone'];
  for (const width of widths)
    for (const theme of ['light', 'dark'])
      for (const surface of surfaces) {
        await page.setViewportSize({ width, height: Number(process.env.WEQ_AI_HEIGHT ?? 900) });
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/ai-images.html?surface=${surface}`,
        );
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.background = theme === 'light' ? 'grid' : 'telegram';
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'light' ? '#075c30' : '#fff3a1',
          );
        }, theme);
        if (surface === 'settings') {
          const vision = page.getByLabel('默认视觉模型', { exact: true });
          await vision.waitFor();
          await vision.selectOption(JSON.stringify(['fixture', 'visual-fixture']));
          for (const label of [
            'WeQ 助手',
            '克隆聊天',
            '克隆训练',
            '意图感知',
            '推荐回复',
            '互动画像',
          ]) {
            const group = page.getByRole('radiogroup', { name: `${label} 图片处理偏好` });
            assert.equal(
              await group.getByRole('radio', { name: '文字占位', exact: true }).count(),
              ['WeQ 助手', '克隆聊天'].includes(label) ? 0 : 1,
            );
            await group.getByRole('radio', { name: 'OCR', exact: true }).click();
            assert.equal(
              await group
                .getByRole('radio', { name: 'OCR', exact: true })
                .getAttribute('aria-checked'),
              'true',
            );
            await group.getByRole('radio', { name: '视觉模型', exact: true }).click();
            assert.equal(
              await group
                .getByRole('radio', { name: '视觉模型', exact: true })
                .getAttribute('aria-checked'),
              'true',
            );
          }
        } else if (surface === 'new-clone') {
          await page.getByRole('button', { name: /下一步/ }).click();
          const preference = page.getByRole('radiogroup', { name: '克隆训练 图片处理偏好' });
          await preference.waitFor();
          assert.equal(await page.getByText('分析 TA 的自定义表情包').count(), 0);
          assert.equal(await page.getByLabel('克隆视觉模型', { exact: true }).count(), 0);
          for (const label of ['OCR', '视觉模型', '文字占位']) {
            await preference.getByRole('radio', { name: label, exact: true }).click();
            assert.equal(
              await preference
                .getByRole('radio', { name: label, exact: true })
                .getAttribute('aria-checked'),
              'true',
            );
          }
          await page.getByRole('button', { name: /开始克隆/ }).click();
          assert.deepEqual(
            await page.evaluate(
              () =>
                window.imageRequests().find((request) => request.name === 'startClone')?.input
                  .models,
            ),
            { chat: { useDefault: true } },
          );
        } else {
          const file = page.locator('.weq-ai-attachments > input[type="file"]');
          await file.waitFor({ state: 'attached' });
          await file.setInputFiles({ name: '合成截图.png', mimeType: 'image/png', buffer: png });
          await page.waitForFunction(
            () => document.querySelectorAll('.weq-ai-attachments .weq-ai-image img').length === 1,
          );
          await page.waitForFunction(() =>
            [...document.querySelectorAll('.weq-ai-attachments img')].every(
              (image) => image.complete && image.naturalWidth > 0,
            ),
          );
          const remove = page.getByRole('button', { name: /移除合成截图/ });
          if (process.env.WEQ_AI_DEBUG) {
            if (output)
              await page.screenshot({
                path: resolve(output, `pending-${surface}-${theme}-${width}.png`),
                fullPage: true,
              });
            console.log(
              JSON.stringify(
                await page.evaluate(() =>
                  [
                    '.chat-pane',
                    '.composer',
                    '.composer-extensions',
                    '.composer-editor',
                    '.weq-ai-attachments',
                    '.weq-ai-image-remove',
                  ].map((selector) => {
                    const element = document.querySelector(selector);
                    if (!element) return { selector };
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return {
                      selector,
                      top: rect.top,
                      bottom: rect.bottom,
                      height: rect.height,
                      rows: style.gridTemplateRows,
                      gridRow: style.gridRow,
                      position: style.position,
                      z: style.zIndex,
                      layout: document.documentElement.dataset.weqLayout,
                    };
                  }),
                ),
              ),
            );
          }
          await remove.click();
          assert.equal(await page.locator('.weq-ai-attachments .weq-ai-image').count(), 0);
          await file.setInputFiles({ name: '合成截图.png', mimeType: 'image/png', buffer: png });
          await page.waitForFunction(
            () => document.querySelectorAll('.weq-ai-attachments .weq-ai-image img').length === 1,
          );
          const imageSend = page.getByRole('button', { name: '发送图片', exact: true });
          if (await imageSend.count()) await imageSend.click();
          else await page.getByRole('textbox', { name: '消息', exact: true }).press('Enter');
          await page
            .getByText(
              surface === 'assistant'
                ? '合成助手看图回复'
                : surface === 'clone'
                  ? '合成克隆看图回复'
                  : '合成群聊看图回复',
              { exact: true },
            )
            .waitFor();
          assert.equal(
            await page.evaluate(() =>
              window.imageRequests().some((request) => request.input?.images?.length === 1),
            ),
            true,
          );
          assert.ok(
            await page.locator('.weq-ai-images img').count(),
            `${surface}/${theme}/${width} lost image after send`,
          );
        }
        if (output)
          await page.screenshot({
            path: resolve(output, `${surface}-${theme}-${width}.png`),
            fullPage: true,
          });
        const overflow = await page.evaluate(() =>
          [...document.querySelectorAll('body *')]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.width && rect.right > innerWidth + 1;
            })
            .slice(0, 8)
            .map((element) => ({ tag: element.tagName, class: element.className })),
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `${surface}/${theme}/${width} overflow: ${JSON.stringify(overflow)}`,
        );
        cases++;
      }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
