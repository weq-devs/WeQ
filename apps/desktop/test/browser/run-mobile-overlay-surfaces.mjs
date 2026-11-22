import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const engine = process.env.WEQ_BROWSER_ENGINE ?? 'chromium';
const output = process.env.WEQ_MOBILE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, `node_modules/.cache/mobile-overlay-surfaces-${engine}-vite`),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/mobile-overlay-surfaces.stub.ts'),
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
  browser = await engines[engine].launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    reducedMotion: 'reduce',
    userAgent: 'Mozilla/5.0 (iPhone) WeQRemote',
  });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.addInitScript(() => {
    Object.defineProperty(screen, 'orientation', {
      configurable: true,
      value: Object.assign(new EventTarget(), { type: 'portrait-primary' }),
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: Object.assign(new EventTarget(), { height: innerHeight, offsetTop: 0, scale: 1 }),
    });
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/mobile-overlay-surfaces.html`;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  const surfaces = [
    'qr',
    'gift',
    'gift-detail',
    'album',
    'files',
    'failure',
    'export',
    'editor',
    'kick',
    'left-members',
    'baseline',
    'dress',
  ];
  const requested = process.argv.slice(2);
  assert(
    requested.every((surface) => surfaces.includes(surface)),
    '未知的弹窗名称',
  );
  for (const surface of requested.length ? requested : surfaces) {
    for (const [width, height] of [
      [320, 640],
      [390, 844],
      [430, 932],
      [844, 320],
      [1180, 820],
    ]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height });
        await page.goto(url);
        await page.waitForFunction(() => window.mobileOverlayQa);
        await page.evaluate(
          ({ surface, theme, width, height }) => {
            screen.orientation.type = width > height ? 'landscape-primary' : 'portrait-primary';
            screen.orientation.dispatchEvent(new Event('change'));
            const store = window.mobileOverlayQa.theme.getState();
            store.setPreference(theme);
            store.setAccent(theme === 'light' ? '#15764a' : '#ebbd51');
            store.setBackground(theme === 'light' ? 'grid' : 'telegram');
            const style = document.documentElement.style;
            for (const [side, value] of Object.entries({
              top: 24,
              bottom: 20,
              left: width > height ? 24 : 0,
              right: width > height ? 16 : 0,
            }))
              style.setProperty(`--weq-safe-${side}`, `${value}px`);
            window.mobileOverlayQa.show(surface);
          },
          { surface, theme, width, height },
        );
        await page.locator('[role="dialog"]').first().waitFor();
        if (surface === 'gift-detail') await page.locator('.weq-gift-card').first().click();
        for (const keyboard of [false, true]) {
          const input = page.locator(surface === 'gift-detail' ? 'textarea' : 'input').first();
          if (keyboard && (await input.count())) await input.focus();
          const viewport = {
            height: keyboard ? Math.min(240, height) : height,
            top: keyboard ? 48 : 0,
          };
          await page.evaluate(({ height, top }) => {
            window.visualViewport.height = height;
            window.visualViewport.offsetTop = top;
            window.visualViewport.dispatchEvent(new Event('resize'));
          }, viewport);
          await page.waitForTimeout(80);
          const geometry = await page
            .locator('[role="dialog"]')
            .first()
            .evaluate((node) => {
              node.scrollTop = 0;
              const r = node.getBoundingClientRect();
              const v = window.visualViewport;
              return {
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
                viewportTop: v.offsetTop,
                viewportBottom: v.offsetTop + v.height,
                overflow: document.documentElement.scrollWidth > innerWidth,
                contentReachable:
                  node.scrollHeight <= node.clientHeight + 1 ||
                  /auto|scroll/.test(getComputedStyle(node).overflowY),
              };
            });
          const context = JSON.stringify({ surface, width, height, theme, keyboard, geometry });
          assert(geometry.top >= geometry.viewportTop + 23, context);
          assert(geometry.bottom <= geometry.viewportBottom - 11, context);
          assert(geometry.left >= 0 && geometry.right <= width + 1 && !geometry.overflow, context);
          assert(geometry.contentReachable, context);
          const close = page
            .locator(
              '[role="dialog"] button[aria-label*="关闭"], [role="dialog"] button[title="关闭"]',
            )
            .first();
          await close.scrollIntoViewIfNeeded();
          await close.click({ trial: true });
          const footer = page.locator('[role="dialog"] footer button').last();
          if (await footer.count()) {
            // 即使提交因空选择被禁用，底部取消按钮也必须可触及。
            const buttons = page.locator('[role="dialog"] footer button:not(:disabled)');
            for (const button of ['editor', 'dress'].includes(surface)
              ? await buttons.all()
              : [buttons.first()]) {
              await button.scrollIntoViewIfNeeded();
              await button.click({ trial: true });
              const { x, width: buttonWidth } = await button.boundingBox();
              assert(x >= geometry.left && x + buttonWidth <= geometry.right + 1, context);
            }
          }
          if (surface === 'editor') {
            const lastField = page.locator('[role="dialog"] input').last();
            await lastField.scrollIntoViewIfNeeded();
            await lastField.click({ trial: true });
            const { x, width: fieldWidth } = await lastField.boundingBox();
            assert(x >= geometry.left && x + fieldWidth <= geometry.right + 1, context);
          }
          if (surface === 'dress') {
            const shops = page.getByRole('button', { name: '商城', exact: true });
            const shop = shops.last();
            await shop.scrollIntoViewIfNeeded();
            const { x, width: shopWidth } = await shop.boundingBox();
            assert(x >= geometry.left && x + shopWidth <= geometry.right + 1, context);
            await shop.click();
            const picker = page.getByRole('dialog', { name: '选择装扮' });
            await picker.waitFor();
            const box = await picker.boundingBox();
            assert(
              box.y >= viewport.top + 23 &&
                box.y + box.height <= viewport.top + viewport.height - 11,
              context,
            );
            await picker.getByRole('button', { name: /合成款 7/ }).click({ trial: true });
            await picker.getByTitle('返回', { exact: true }).click();
          }
          if (surface === 'gift-detail') {
            const send = page.locator('.weq-gift-send');
            await send.scrollIntoViewIfNeeded();
            await send.click({ trial: true });
            await page.locator('.weq-gift-close').click({ trial: true });
          }
          if (output && !keyboard && [390, 844].includes(width)) {
            await page
              .locator('[role="dialog"]')
              .first()
              .evaluate((node) => {
                node.scrollTop = 0;
              });
            await page.screenshot({
              path: resolve(output, `${engine}-${surface}-${width}-${theme}.png`),
            });
          }
          cases++;
        }
        await page.evaluate(() => window.mobileOverlayQa.child());
        await page.locator('.weq-message-modal').waitFor();
        assert.equal(await page.evaluate(() => window.mobileOverlayQa.back()), true);
        await page.locator('.weq-message-modal').waitFor({ state: 'detached' });
        assert.equal(
          await page.locator('[role="dialog"]').count(),
          1,
          '子确认框返回不能连带关闭父层',
        );
        assert.equal(await page.evaluate(() => window.mobileOverlayQa.back()), true);
        await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => window.mobileOverlayQa.back()), false);
      }
    }
    console.log(JSON.stringify({ surface, cases }));
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine, cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
