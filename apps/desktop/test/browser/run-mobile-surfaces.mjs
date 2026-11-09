import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-mobile-surfaces'),
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
  const page = await browser.newPage({
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  });
  const errors = [],
    failures = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/mobile-surfaces.html`,
  );
  await page.waitForSelector('.weq-self-profile-body');
  const output = process.env.WEQ_MOBILE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const surface of process.env.WEQ_MOBILE_SURFACES?.split(',') ?? [
    'profile',
    'profile-face',
    'lookup',
    'lookup-result',
    'collections',
    'mail',
    'mail-compose',
    'channel',
    'channel-direct',
    'qzone',
    'qzone-compose',
    'settings',
    'settings-appearance',
    'settings-account',
    'settings-display',
  ]) {
    const base =
      surface === 'lookup-result'
        ? 'lookup'
        : surface === 'profile-face'
          ? 'profile'
          : surface === 'mail-compose'
            ? 'mail'
            : surface === 'qzone-compose'
              ? 'qzone'
              : surface;
    await page.evaluate((surface) => window.mobileSurfacesQa.show(surface), base);
    await page.waitForSelector(`[data-surface="${base}"]`);
    if (surface === 'lookup-result') {
      await page.locator('.weq-friend-directory-editor input').fill('10001');
      await page.locator('.weq-friend-directory-editor button[type="submit"]').click();
      await page.waitForSelector('.weq-friend-directory-editor dl');
    }
    if (surface === 'profile-face')
      await page.getByRole('button', { name: '状态表情', exact: true }).click();
    if (surface === 'mail-compose')
      await page.getByRole('button', { name: '写邮件', exact: true }).click();
    if (surface === 'qzone-compose')
      await page.getByRole('button', { name: '写说说', exact: true }).click();
    await page.evaluate(() =>
      Promise.all(
        [...document.querySelectorAll('.weq-modal')].flatMap((node) =>
          node.getAnimations().map((animation) => animation.finished.catch(() => {})),
        ),
      ),
    );
    for (const width of [320, 390, 430, 760, 1180]) {
      for (const height of [844, 430]) {
        await page.setViewportSize({ width, height });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(
            (theme) => window.mobileSurfacesQa.theme.getState().setPreference(theme),
            theme,
          );
          await page.waitForTimeout(30);
          const result = await page.evaluate(() => {
            const visible = (el) =>
              el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
            const modal = document.querySelector('.weq-modal[role="dialog"]');
            const container = modal ?? document.querySelector('.fixture-page');
            const bounds = container.getBoundingClientRect();
            const overflow = [
              ...container.querySelectorAll(
                'input,select,textarea,button,.weq-set-row-main,.weq-set-row-ctrl',
              ),
            ]
              .filter(visible)
              .filter((el) => {
                const rect = el.getBoundingClientRect();
                return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
              })
              .map(
                (el) =>
                  el.getAttribute('aria-label') || el.className || el.textContent?.slice(0, 40),
              );
            const profileRows = [...container.querySelectorAll('.weq-qq-write-panel .weq-set-row')];
            const stacked =
              innerWidth > 760 ||
              profileRows.every((row) => {
                const label = row.querySelector('.weq-set-row-main').getBoundingClientRect();
                const control = row.querySelector('.weq-set-row-ctrl').getBoundingClientRect();
                return (
                  control.top >= label.bottom - 1 &&
                  Math.abs(control.left - row.getBoundingClientRect().left) <= 1
                );
              });
            const fieldsFit = [
              ...container.querySelectorAll(
                '.weq-qq-write-field,.weq-qq-write-custom,.weq-profile-region-editor',
              ),
            ].every((el) => el.scrollWidth <= el.clientWidth + 1);
            const smallControls =
              innerWidth > 760
                ? []
                : [
                    ...container.querySelectorAll(
                      '.weq-self-profile-dialog .weq-set-iconbtn,.weq-self-profile-dialog .weq-qq-write-face-trigger,.weq-self-profile-dialog .weq-qq-write-input,.weq-self-profile-dialog .weq-profile-region-editor select,.weq-self-profile-dialog .weq-profile-region-editor input',
                    ),
                  ]
                    .filter(visible)
                    .filter((el) => el.getBoundingClientRect().height < 44)
                    .map((el) => ({
                      label: el.getAttribute('aria-label'),
                      height: el.getBoundingClientRect().height,
                      minHeight: getComputedStyle(el).minHeight,
                    }));
            return {
              contentReachable:
                container.scrollHeight <= container.clientHeight + 1 ||
                ['auto', 'scroll'].includes(getComputedStyle(container).overflowY),
              bounds: { top: bounds.top, bottom: bounds.bottom },
              visualViewport: {
                height: window.visualViewport?.height,
                top: window.visualViewport?.offsetTop,
              },
              rendered: Boolean(container.querySelector('button,input,textarea')),
              smallControls,
              overflow,
              stacked,
              fieldsFit,
              bounded:
                bounds.left >= 0 &&
                bounds.right <= innerWidth + 1 &&
                (!modal || (bounds.top >= 0 && bounds.bottom <= innerHeight + 1)),
              scrollWidth: container.scrollWidth,
              clientWidth: container.clientWidth,
            };
          });
          if (
            result.overflow.length ||
            !result.rendered ||
            !result.contentReachable ||
            result.smallControls.length ||
            !result.stacked ||
            !result.fieldsFit ||
            !result.bounded ||
            result.scrollWidth > result.clientWidth + 1
          )
            failures.push({ surface, width, height, theme, ...result });
          cases++;
          if (output && width === 390 && height === 844)
            await page.screenshot({ path: resolve(output, `${surface}-${theme}.png`) });
        }
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const viewport = Object.assign(new EventTarget(), { height: 320, offsetTop: 96, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    window.mobileSurfacesQa.show('lookup');
  });
  await page.waitForSelector('.weq-friend-directory-editor');
  await page.evaluate(() => window.mobileSurfacesQa.show('profile'));
  await page.waitForSelector('.weq-self-profile-body');
  await page.waitForTimeout(50);
  const keyboardFits = await page.locator('.weq-self-profile-dialog').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return rect.top >= 96 && rect.bottom <= 416;
  });
  if (!keyboardFits) failures.push({ surface: 'profile', keyboard: '弹窗超出可视视口' });
  await page.evaluate(() => window.mobileSurfacesQa.show('qzone'));
  await page.getByRole('button', { name: '写说说', exact: true }).click();
  await page.evaluate(() => {
    window.visualViewport.height = 240;
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(50);
  const composerReachable = await page.locator('.weq-qzn-composer').evaluate((node) => {
    const modal = node.closest('.weq-modal').getBoundingClientRect();
    if (node.getBoundingClientRect().bottom > modal.bottom + 1) return false;
    node.scrollTop = node.scrollHeight;
    const footer = node.querySelector('footer').getBoundingClientRect();
    return footer.bottom <= modal.bottom && getComputedStyle(node).overflowY === 'auto';
  });
  if (!composerReachable)
    failures.push({ surface: 'qzone-compose', keyboard: '底部操作被裁切且无法滚动到达' });
  console.log(JSON.stringify({ cases, failures, errors }, null, 2));
  if (failures.length || errors.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
