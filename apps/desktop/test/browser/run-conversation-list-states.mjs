import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-conversation-states'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
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
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/conversation-list-states.html`,
    );
    await page.locator('.weq-conversation-directory .conversation-row').first().waitFor();
    for (const theme of ['light', 'dark']) {
      for (const style of ['qqnt', 'classic', 'minimal', 'retro']) {
        for (const density of ['comfortable', 'compact']) {
          await page.evaluate(
            (theme) => window.conversationStatesQa.store.getState().setPreference(theme),
            theme,
          );
          await page.waitForFunction(
            (theme) => document.documentElement.dataset.theme === theme,
            theme,
          );
          await page.evaluate(
            ({ theme, style, density }) => {
              const store = window.conversationStatesQa.store.getState();
              store.setComponentStyle(style);
              store.setDensity(density);
              store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
              store.setBackground(theme === 'light' ? 'plain' : 'grid');
            },
            { theme, style, density },
          );
          const sample = (row) =>
            row.evaluate((node) => {
              const css = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return {
                width: rect.width,
                height: rect.height,
                radius: css.borderRadius,
                background: css.backgroundColor,
                shadow: css.boxShadow,
                clip: css.backgroundClip,
              };
            });
          const active = page.locator('.weq-conversation-directory [data-conversation-id="10001"]');
          const inactive = page.locator(
            '.weq-conversation-directory [data-conversation-id="10002"]',
          );
          await page.locator('.weq-merged-overlay').evaluate((node) => {
            node.style.visibility = 'hidden';
          });
          await inactive.hover();
          const hovered = await sample(inactive);
          const selected = await sample(active);
          for (const key of ['width', 'height', 'radius', 'clip'])
            assert.equal(
              hovered[key],
              selected[key],
              `${width}/${theme}/${style}/${density}: ${key}`,
            );
          if (style === 'qqnt')
            assert.equal(hovered.shadow, selected.shadow, '悬停底色应与选中底色使用相同内缩');
          if (output && style === 'qqnt' && density === 'comfortable')
            await page.screenshot({ path: resolve(output, `${width}-${theme}-hover.png`) });
          await inactive.click({ button: 'right' });
          const target = await sample(inactive);
          assert.equal(
            target.background,
            selected.background,
            `${theme}/${style}: 右键底色应与已进入会话相同`,
          );
          await page.keyboard.press('Escape');
          await active.click({ button: 'right' });
          assert.equal((await sample(active)).background, target.background);
          await page.keyboard.press('Escape');
          await page.locator('.weq-merged-overlay').evaluate((node) => {
            node.style.visibility = 'visible';
          });
          const assistant = page.locator('.weq-conversation-list [data-conversation-id="10002"]');
          await assistant.click({ button: 'right' });
          await page.getByRole('menu').waitFor();
          assert.equal(
            (await sample(assistant)).background,
            target.background,
            `${theme}/${style}: 群助手应使用同一选中底色`,
          );
          assert.ok(
            await assistant.evaluate((node) => node.classList.contains('is-context-target')),
          );
          const copy = page.getByRole('menuitem', { name: '复制群号', exact: true });
          await copy.click();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '10002');
          await copy.getByRole('status').waitFor();
          if (style === 'qqnt' && density === 'comfortable') {
            await page.waitForTimeout(1450);
            const opacity = await copy
              .getByRole('status')
              .evaluate((node) => Number(getComputedStyle(node).opacity));
            assert.ok(opacity > 0 && opacity < 1, `反馈应淡出：${opacity}`);
            if (output)
              await page.screenshot({ path: resolve(output, `${width}-${theme}-${style}.png`) });
          }
          await page.keyboard.press('Escape');
          results.push({ width, theme, style, density, hovered, selected, target });
        }
      }
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page
    .locator('.weq-conversation-list [data-conversation-id="10002"]')
    .click({ button: 'right' });
  const reducedCopy = page.getByRole('menuitem', { name: '复制群号', exact: true });
  await reducedCopy.click();
  assert.equal(
    await reducedCopy.getByRole('status').evaluate((node) => getComputedStyle(node).animationName),
    'none',
  );
  await reducedCopy.getByRole('status').waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        cases: results.length,
        widths: [1280, 390],
        themes: ['light', 'dark'],
        styles: ['qqnt', 'classic', 'minimal', 'retro'],
        reducedMotion: true,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
