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
          await page.evaluate((theme) => {
            const store = window.mobileSurfacesQa.theme.getState();
            store.setPreference(theme);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            store.setBackground(theme === 'light' ? 'grid' : 'telegram');
          }, theme);
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
            const profile =
              container.querySelector('.weq-self-profile-dialog') ??
              (container.matches('.weq-self-profile-dialog') ? container : null);
            const profileStyleIssues = [];
            if (profile) {
              const expectedSize = innerWidth <= 760 ? '16px' : '13px';
              for (const control of profile.querySelectorAll(
                '.weq-qq-write-input,.weq-profile-region-editor select,.weq-profile-region-editor input,.weq-segmented > button',
              )) {
                const style = getComputedStyle(control);
                if (style.fontSize !== expectedSize)
                  profileStyleIssues.push({
                    label: control.getAttribute('aria-label') ?? control.textContent,
                    fontSize: style.fontSize,
                    expectedSize,
                  });
                if (control.matches('select') && control.getBoundingClientRect().height < 35)
                  profileStyleIssues.push('下拉框高度低于其他输入控件');
              }
              if (!profile.querySelector('.weq-set-card .weq-self-profile-additional'))
                profileStyleIssues.push('补充资料未归入资料分组');
              if (profile.querySelector('.weq-qq-live-status'))
                profileStyleIssues.push('仍显示重复的服务端状态行');
            }
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
              profileStyleIssues,
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
            result.profileStyleIssues.length ||
            !result.stacked ||
            !result.fieldsFit ||
            !result.bounded ||
            result.scrollWidth > result.clientWidth + 1
          )
            failures.push({ surface, width, height, theme, ...result });
          cases++;
          if (output && [390, 1180].includes(width) && height === 844) {
            await page.screenshot({ path: resolve(output, `${surface}-${theme}-${width}.png`) });
            if (surface === 'profile') {
              const body = page.locator('.weq-self-profile-body');
              const scrollTop = await body.evaluate((node) => {
                const top = node.scrollTop;
                node.scrollTop = node.scrollHeight;
                return top;
              });
              await page.screenshot({
                path: resolve(output, `${surface}-${theme}-${width}-status.png`),
              });
              await body.evaluate((node, top) => {
                node.scrollTop = top;
              }, scrollTop);
            }
          }
        }
      }
    }
  }
  // 不只检查动画结束后的布局：父级后台刷新不得让次级页面反复播放进出动画。
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/mobile-surfaces.html?navigation`,
  );
  await page.waitForSelector('.weq-self-profile-body');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const surface of ['mail', 'channel-direct']) {
    await page.evaluate((surface) => window.mobileSurfacesQa.show(surface), surface);
    await page.waitForSelector(`[data-surface="${surface}"]`);
    for (const width of [320, 390, 760]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          (theme) => window.mobileSurfacesQa.theme.getState().setPreference(theme),
          theme,
        );
        await page.waitForTimeout(300);
        const result = await page.evaluate(async () => {
          const target = document.querySelector('.chat-main');
          const initial = target.getBoundingClientRect();
          let minLeft = initial.left,
            maxLeft = initial.left,
            animations = 0;
          for (let refresh = 0; refresh < 12; refresh++) {
            window.mobileSurfacesQa.refresh();
            for (let frame = 0; frame < 3; frame++) {
              await new Promise(requestAnimationFrame);
              const rect = target.getBoundingClientRect();
              minLeft = Math.min(minLeft, rect.left);
              maxLeft = Math.max(maxLeft, rect.left);
              animations += target.getAnimations().length;
            }
          }
          return { minLeft, maxLeft, animations };
        });
        if (result.maxLeft - result.minLeft > 1 || result.animations)
          failures.push({ surface, width, theme, refreshJitter: result });
        cases++;
        if (output && width === 390)
          await page.screenshot({ path: resolve(output, `${surface}-refresh-${theme}.png`) });
      }
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/mobile-surfaces.html`,
  );
  await page.waitForSelector('.weq-self-profile-body');
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
