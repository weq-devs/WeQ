import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-contact-overview'),
  define: {
    'import.meta.env.VITE_WEQ_TARGET': JSON.stringify(
      process.env.WEQ_OVERVIEW_TARGET ?? 'electron',
    ),
  },
  plugins: [react(), tailwind()],
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
  const errors = [];
  const output = process.env.WEQ_OVERVIEW_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ||
      route.request().url().startsWith('data:')
        ? route.continue()
        : route.abort(),
    );
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-overview.html`,
    );
    const sidebar = page.locator('.app-shell-root > .app-shell > .sidebar');
    const row = sidebar.locator('.sidebar-header .contact-notice-row');
    await row.waitFor();
    for (const preset of ['classic', 'minimal', 'retro', 'qqnt'])
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          ({ theme, preset }) => {
            const store = window.contactOverviewQa.theme.getState();
            store.setPreference(theme);
            store.setComponentStyle(preset);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            store.setBackground(theme === 'light' ? 'plain' : 'grid');
          },
          { theme, preset },
        );
        assert.deepEqual(await row.locator(':scope > button').allTextContents(), [
          '好友通知',
          '群通知',
          '群交集',
        ]);
        assert.equal(
          await row.locator('.notice-entry-text:visible').count(),
          3,
          JSON.stringify({
            width,
            preset,
            theme,
            buttons: await row.locator(':scope > button').evaluateAll((buttons) =>
              buttons.map((button) => ({
                width: button.clientWidth,
                font: getComputedStyle(button).font,
                padding: getComputedStyle(button).padding,
                text: button.textContent,
                display: getComputedStyle(button.querySelector('.notice-entry-text')).display,
              })),
            ),
          }),
        );
        assert.equal(
          await row.evaluate((node) => {
            const buttons = [...node.querySelectorAll('button')];
            return buttons.every((button, index) => {
              const box = button.getBoundingClientRect();
              const text = button.querySelector('.notice-entry-text');
              const textBox = text.getBoundingClientRect();
              const next = buttons[index + 1]?.getBoundingClientRect();
              return (
                (!next || box.right <= next.left) &&
                (getComputedStyle(text).display === 'none' ||
                  (textBox.left >= box.left && textBox.right <= box.right + 1))
              );
            });
          }),
          true,
          `${width}/${preset}/${theme}: entries fit`,
        );
        if (width <= 760) {
          await sidebar
            .locator('.contact-tab-switch')
            .getByRole('button', { name: '群聊', exact: true })
            .click();
          await sidebar.locator('[data-directory-scroll]').evaluate((node) => {
            node.scrollTop = 500;
          });
        }
        if (output && preset === 'classic')
          await page.screenshot({ path: resolve(output, `${width}-${theme}-list.png`) });
        await row.getByRole('button', { name: '群交集', exact: true }).click();
        await page.locator('.chat-main .weq-relhome').waitFor({ state: 'visible' });
        if (width <= 760) {
          assert.equal(
            await page.locator('.app-shell-root').getAttribute('data-mobile-detail'),
            'true',
          );
          const back = page.getByRole('button', { name: '返回联系人列表', exact: true });
          await back.waitFor({ state: 'visible' });
          if (output && preset === 'classic')
            await page.screenshot({ path: resolve(output, `${width}-${theme}-overview.png`) });
          await back.click();
          await page.waitForFunction(
            () => !document.querySelector('.app-shell-root').hasAttribute('data-mobile-detail'),
          );
          assert.equal(
            await sidebar.locator('[data-directory-scroll]').evaluate((node) => node.scrollTop),
            500,
          );
          assert.match(
            await sidebar.locator('.contact-tab-switch button.active').innerText(),
            /群聊/,
          );
          await row.getByRole('button', { name: '群交集', exact: true }).click();
          await page.evaluate(() => window.weqMobileNavigation.back());
          await page.waitForFunction(
            () => !document.querySelector('.app-shell-root').hasAttribute('data-mobile-detail'),
          );
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        cases++;
      }
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, navigation: 'passed' }));
} finally {
  await browser?.close();
  await server.close();
}
