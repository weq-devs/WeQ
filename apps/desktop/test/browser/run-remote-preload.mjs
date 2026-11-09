import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/mobile-surfaces.stub.ts'),
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
  browser = await webkit.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/remote-preload.html`,
  );
  const output = process.env.WEQ_MOBILE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const settled = () => page.locator('.weq-mobile-transition').waitFor({ state: 'detached' });
  await page.waitForSelector('[data-mobile-sidebar-active="false"]', { state: 'attached' });
  const contacts = await page.locator('[data-mobile-sidebar-active="false"]').elementHandle();
  await page.locator('[data-mobile-tab="contacts"]').click();
  await settled();
  assert.equal(await contacts.evaluate((el) => el.dataset.mobileSidebarActive), 'true');
  await page.locator('.app-shell').getByText('我的好友', { exact: true }).click();
  await page.locator('.app-shell').getByText('合成联系人 0', { exact: true }).waitFor();
  await page.locator('[data-mobile-tab="messages"]').click();
  await settled();
  await page.locator('[data-mobile-tab="contacts"]').click();
  await settled();
  assert.equal(
    await contacts.evaluate((el) => el.isConnected && el.dataset.mobileSidebarActive === 'true'),
    true,
  );
  await page.locator('.app-shell').getByText('合成联系人 0', { exact: true }).waitFor();
  // 半程必须同时看见两页，而不是等手势结束才挂载目标画面。
  await page
    .locator('.app-shell > .sidebar')
    .dispatchEvent('touchstart', { touches: [{ clientX: 280, clientY: 400 }] });
  await page
    .locator('.app-shell > .sidebar')
    .dispatchEvent('touchmove', { touches: [{ clientX: 85, clientY: 400 }], cancelable: true });
  const half = await page.locator('[data-mobile-transition-page]').evaluateAll((pages) =>
    pages.map((el) => ({
      page: el.dataset.mobileTransitionPage,
      left: el.getBoundingClientRect().left,
      right: el.getBoundingClientRect().right,
      text: el.textContent,
    })),
  );
  assert.equal(half.length, 2);
  assert.equal(half[0].page, 'contacts');
  assert.equal(half[1].page, 'qzone');
  assert.ok(Math.abs(half[0].right - half[1].left) < 1);
  assert.ok(half[1].left > 0 && half[1].left < 390);
  assert.ok(half[1].text.includes('QQ 空间'));
  if (output) await page.screenshot({ path: resolve(output, 'contacts-qzone-half.png') });
  await page.locator('.app-shell > .sidebar').dispatchEvent('touchcancel', { touches: [] });
  await settled();
  assert.equal(
    await page.locator('[data-mobile-tab="contacts"]').getAttribute('aria-current'),
    'page',
  );
  // 空间进入一帧后就离开，不能挂载内容。
  assert.equal(
    await page.evaluate(async () => {
      window.remotePreloadQa.navigate('qzone');
      await new Promise(requestAnimationFrame);
      const mounted = Boolean(
        document.querySelector('.app-shell .weq-qzn:not([data-qzone-loading-preview])'),
      );
      window.remotePreloadQa.navigate('more');
      return mounted;
    }),
    false,
  );
  await page.waitForTimeout(500);
  assert.equal(
    await page.locator('.app-shell .weq-qzn:not([data-qzone-loading-preview])').count(),
    0,
  );
  await page.locator('[data-mobile-tab="qzone"]').click();
  await settled();
  await page.locator('.app-shell .weq-qzn:not([data-qzone-loading-preview])').waitFor();
  const qzone = await page
    .locator('.app-shell .weq-qzn:not([data-qzone-loading-preview])')
    .elementHandle();
  await page
    .locator('.app-shell > .chat-main')
    .dispatchEvent('touchstart', { touches: [{ clientX: 180, clientY: 400 }] });
  await page
    .locator('.app-shell > .chat-main')
    .dispatchEvent('touchmove', { touches: [{ clientX: 120, clientY: 400 }], cancelable: true });
  assert.equal(await qzone.evaluate((el) => el.isConnected), true);
  assert.ok(
    await page
      .locator('[data-mobile-transition-page="more"]')
      .textContent()
      .then((text) => text.includes('QQ 邮箱')),
  );
  await page.locator('.app-shell > .chat-main').dispatchEvent('touchcancel', { touches: [] });
  await settled();
  assert.equal(await qzone.evaluate((el) => el.isConnected), true);
  let gestureCases = 0;
  for (const [from, to] of [
    ['messages', 'contacts'],
    ['contacts', 'qzone'],
    ['qzone', 'more'],
    ['more', 'qzone'],
    ['qzone', 'contacts'],
    ['contacts', 'messages'],
  ]) {
    await page.evaluate((from) => window.remotePreloadQa.navigate(from), from);
    await page.waitForTimeout(400);
    const source = page.locator(
      from === 'more'
        ? '.weq-mobile-navigation > .weq-mobile-more'
        : from === 'qzone'
          ? '.app-shell > .chat-main'
          : '.app-shell > .sidebar',
    );
    const forward =
      ['messages', 'contacts', 'qzone', 'more'].indexOf(to) >
      ['messages', 'contacts', 'qzone', 'more'].indexOf(from);
    const x = forward ? 280 : 100;
    await source.dispatchEvent('touchstart', { touches: [{ clientX: x, clientY: 400 }] });
    await source.dispatchEvent('touchmove', {
      touches: [{ clientX: x + (forward ? -195 : 195), clientY: 400 }],
      cancelable: true,
    });
    assert.deepEqual(
      await page
        .locator('[data-mobile-transition-page]')
        .evaluateAll((pages) => pages.map((p) => p.dataset.mobileTransitionPage)),
      [from, to],
    );
    await source.dispatchEvent('touchend', { touches: [] });
    await settled();
    assert.equal(
      await page.locator(`[data-mobile-tab="${to}"]`).getAttribute('aria-current'),
      'page',
    );
    gestureCases++;
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const source = page.locator('.app-shell > .sidebar');
  await source.dispatchEvent('touchstart', { touches: [{ clientX: 280, clientY: 400 }] });
  await source.dispatchEvent('touchmove', {
    touches: [{ clientX: 85, clientY: 400 }],
    cancelable: true,
  });
  assert.equal(
    await page
      .locator('[data-mobile-transition-page="contacts"]')
      .evaluate((el) => el.style.transform),
    '',
  );
  assert.equal(
    await page
      .locator('[data-mobile-transition-page="contacts"]')
      .evaluate((el) => el.style.opacity),
    '0.5',
  );
  // 第二根手指取消后，后续 touchend 不能再次提交切页。
  await source.dispatchEvent('touchmove', {
    touches: [
      { clientX: 85, clientY: 400 },
      { clientX: 90, clientY: 400 },
    ],
    cancelable: true,
  });
  await source.dispatchEvent('touchend', { touches: [] });
  await settled();
  assert.equal(
    await page.locator('[data-mobile-tab="messages"]').getAttribute('aria-current'),
    'page',
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        window.remotePreloadQa.theme.getState().setPreference(theme);
        window.remotePreloadQa.navigate('contacts');
      }, theme);
      await page.waitForTimeout(250);
      assert.equal(
        await page
          .locator('.app-shell > .sidebar .sidebar-body')
          .evaluate((el) => el.clientWidth > 0 && el.clientHeight > 0),
        true,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `contacts-${width}-${theme}.png`) });
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      cases,
      retainedLists: true,
      qzoneSettling: true,
      gestureCases,
      halfwayPages: half.map((p) => ({ page: p.page, left: p.left, right: p.right })),
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
