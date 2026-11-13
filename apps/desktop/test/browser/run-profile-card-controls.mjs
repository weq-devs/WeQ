import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_CONTROLS_QA;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/profile-identity.stub.ts'),
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
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      hasTouch: touch,
      viewport: { width: touch ? 390 : 1180, height: 900 },
    });
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    for (const theme of ['light', 'dark']) {
      for (const expand of [true, false]) {
        const appearances = [];
        for (const kind of ['friend', 'group']) {
          const params = new URLSearchParams({
            popover: '',
            ...(expand ? { controls: '' } : {}),
            ...(kind === 'friend' ? { friend: '' } : {}),
          });
          await page.goto(
            `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-identity.html?${params}`,
          );
          const controls = page.locator('.weq-profile-card-controls');
          await controls.waitFor();
          await page.evaluate((theme) => {
            const store = window.profileIdentityQa.store.getState();
            store.setPreference(theme);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          }, theme);
          await page.waitForFunction(
            (theme) => document.documentElement.dataset.theme === theme,
            theme,
          );
          const buttons = controls.getByRole('button');
          assert.equal(await buttons.count(), expand ? 2 : 1);
          const styles = await buttons.evaluateAll((buttons) =>
            buttons.map((button) => {
              const rect = button.getBoundingClientRect();
              const icon = button.querySelector('svg').getBoundingClientRect();
              const card = button.closest('.weq-contact-card').getBoundingClientRect();
              const style = getComputedStyle(button);
              return {
                top: rect.top - card.top,
                right: card.right - rect.right,
                width: rect.width,
                height: rect.height,
                padding: style.padding,
                color: style.color,
                background: style.backgroundColor,
                centered:
                  Math.abs(icon.x + icon.width / 2 - rect.x - rect.width / 2) < 0.1 &&
                  Math.abs(icon.y + icon.height / 2 - rect.y - rect.height / 2) < 0.1,
                iconWidth: icon.width,
                iconHeight: icon.height,
              };
            }),
          );
          const label = `${touch}/${theme}/${expand}/${kind}`;
          assert.ok(
            styles.every(
              (style) =>
                style.centered &&
                style.iconWidth === 16 &&
                style.iconHeight === 16 &&
                style.padding === '0px',
            ),
            label,
          );
          if (expand) {
            assert.deepEqual(
              { ...styles[0], right: 0 },
              { ...styles[1], right: 0 },
              `${label}: 按钮未对齐或样式不一致`,
            );
            await buttons.first().hover();
            const hover = await buttons
              .first()
              .evaluate((node) => [
                getComputedStyle(node).color,
                getComputedStyle(node).backgroundColor,
              ]);
            await buttons.last().hover();
            assert.deepEqual(
              await buttons
                .last()
                .evaluate((node) => [
                  getComputedStyle(node).color,
                  getComputedStyle(node).backgroundColor,
                ]),
              hover,
            );
          }
          appearances.push(styles);
          await buttons.last().focus();
          assert.equal(
            await buttons.last().evaluate((node) => getComputedStyle(node).outlineStyle),
            'solid',
          );
          if (output && expand)
            await page.screenshot({
              path: resolve(output, `${kind}-${theme}-${touch ? 'touch' : 'desktop'}.png`),
            });
          await buttons.last().press('Enter');
          assert.equal(await page.evaluate(() => window.profileIdentityQa.closes), 1);
          if (expand) {
            await buttons.first().click();
            assert.equal(await page.evaluate(() => window.profileIdentityQa.expands), 1);
          }
          cases++;
        }
        assert.deepEqual(appearances[0], appearances[1], '联系人与群名片的按钮布局应一致');
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, cases }));
} finally {
  await browser?.close();
  await server.close();
}
