import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_NOTICE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-contact-notices'),
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  for (const group of [false, true]) {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-notices.html`,
    );
    await page.evaluate((group) => window.noticeQa.render(group), group);
    await page.waitForSelector('.notice-card-request');
    const time = page.locator('.notice-meta time').first();
    if ((await time.textContent()) !== '2026-11-07 00:00:37')
      throw new Error('通知时间未显示完整的北京时间与秒数');
    await page.evaluate((group) => window.noticeQa.mountActions(group), group);
    await page.waitForSelector('.notice-request-buttons');
    for (const width of [1280, 390, 320]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 600 });
        await page.evaluate((theme) => {
          const store = window.noticeQa.store.getState();
          store.setPreference(theme);
          store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
          store.setBackground(theme === 'light' ? 'paper' : 'grid');
        }, theme);
        const result = await page.evaluate(() => {
          const cards = [...document.querySelectorAll('.notice-card-request')];
          const brokenIdentities = cards.filter((card) => {
            const identity = card.querySelector('.notice-identity');
            const avatar = identity.querySelector('.avatar').getBoundingClientRect();
            const name = identity.querySelector('.notice-who').getBoundingClientRect();
            const bounds = identity.getBoundingClientRect();
            const copy = card.querySelector('.notice-copy').getBoundingClientRect();
            const meta = card.querySelector('.notice-meta').getBoundingClientRect();
            return (
              bounds.width < avatar.width + 24 ||
              name.height > avatar.height + 1 ||
              name.left < avatar.right ||
              name.right > bounds.right + 1 ||
              bounds.right > meta.left + 1 ||
              bounds.bottom > copy.top + 1
            );
          });
          const clipped = cards.filter((card) => {
            const rect = card.getBoundingClientRect();
            const timeClipped = [...card.querySelectorAll('time')].some((time) => {
              const range = document.createRange();
              range.selectNodeContents(time);
              return [...range.getClientRects()].some(
                (line) =>
                  line.right > rect.right + 1 ||
                  line.left < rect.left - 1 ||
                  line.bottom > rect.bottom + 1,
              );
            });
            return (
              timeClipped ||
              [...card.querySelectorAll('button, input, .notice-request-actions > p')].some(
                (node) => {
                  const child = node.getBoundingClientRect();
                  return (
                    child.bottom > rect.bottom + 1 ||
                    child.right > rect.right + 1 ||
                    child.left < rect.left - 1
                  );
                },
              )
            );
          });
          const list = document.querySelector('.weq-notice-scroll');
          const panel = document.querySelector('.weq-notice-panel');
          const workspace = document.querySelector('.weq-workspace-content');
          const panelRect = panel.getBoundingClientRect();
          const workspaceRect = workspace.getBoundingClientRect();
          list.scrollTop = list.scrollHeight;
          const last = cards.at(-1).getBoundingClientRect();
          return {
            brokenIdentities: brokenIdentities.length,
            clipped: clipped.length,
            count: cards.length,
            scrollable: list.scrollHeight > list.clientHeight,
            lastVisible: last.bottom <= list.getBoundingClientRect().bottom + 1,
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            inline:
              Boolean(workspace.querySelector('.weq-notice-panel')) &&
              !document.querySelector('.weq-workspace-page'),
            fitsWorkspace:
              Math.abs(panelRect.left - workspaceRect.left) < 1 &&
              Math.abs(panelRect.width - workspaceRect.width) < 1 &&
              Math.abs(panelRect.height - workspaceRect.height) < 1,
            sidebarVisible:
              innerWidth <= 600 ||
              document.querySelector('.notice-qa-sidebar').getBoundingClientRect().right <=
                panelRect.left,
          };
        });
        if (
          result.brokenIdentities ||
          result.clipped ||
          result.overflow ||
          result.count !== 12 ||
          !result.scrollable ||
          !result.lastVisible ||
          !result.inline ||
          !result.fitsWorkspace ||
          !result.sidebarVisible
        ) {
          if (output)
            await page.screenshot({
              path: resolve(output, `failure-${group ? 'group' : 'friend'}-${width}-${theme}.png`),
            });
          throw new Error(
            `${group ? 'group' : 'friend'}/${width}/${theme}: ${JSON.stringify(result)}`,
          );
        }
        await page.locator('.weq-notice-scroll').evaluate((node) => {
          node.scrollTop = 0;
        });
        if (group) {
          const name = page.locator('button.notice-group-name').first();
          await name.focus();
          await page.keyboard.press('Enter');
          const card = page.getByRole('dialog', { name: '群资料', exact: true });
          await card.waitFor({ state: 'visible' });
          if (!(await card.textContent()).includes('20001'))
            throw new Error('群名没有打开对应群名片');
          await page.keyboard.press('Escape');
          await card.waitFor({ state: 'detached' });
        }
        const person = page.locator('.notice-identity').first();
        await person.locator('.notice-who').click();
        if ((await page.evaluate(() => document.documentElement.dataset.noticeProfile)) !== '10001')
          throw new Error('通知昵称没有打开同一申请人的名片');
        if (output)
          await page.screenshot({
            path: resolve(output, `${group ? 'group' : 'friend'}-${width}-${theme}.png`),
          });
        console.log(`PASS ${group ? 'group' : 'friend'}/${width}/${theme}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser?.close();
  await server.close();
}
