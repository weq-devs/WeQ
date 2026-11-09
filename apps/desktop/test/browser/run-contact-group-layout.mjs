import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_GROUP_LAYOUT_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-contact-group-layout'),
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' || url.protocol === 'data:'
      ? route.continue()
      : route.abort();
  });
  if (output) await mkdir(output, { recursive: true });
  for (const sparse of [false, true]) {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-group-layout.html${sparse ? '?sparse' : ''}`,
    );
    await page.waitForSelector('.group-info-panel');
    for (const width of [1180, 800, 760, 600, 390, 320]) {
      for (const [theme, componentStyle] of [
        ['light', 'qqnt'],
        ['dark', 'qqnt'],
        ['system', 'classic'],
        ['light', 'minimal'],
        ['dark', 'minimal'],
        ['dark', 'retro'],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
        await page.evaluate(
          ({ theme, componentStyle }) => {
            const store = window.groupLayoutQa.store.getState();
            store.setPreference(theme);
            store.setComponentStyle(componentStyle);
            store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
            store.setBackground(theme === 'light' ? 'plain' : 'grid');
            document.querySelector('.weq-contact-profile-content').scrollTop = 0;
          },
          { theme, componentStyle },
        );
        const result = await page.evaluate(() => {
          const panel = document.querySelector('.group-info-panel');
          const overview = panel.querySelector('.group-info-overview');
          const members = panel.querySelector('.member-list-section');
          const list = members.querySelector('.group-info-member-list');
          const content = document.querySelector('.weq-contact-profile-content');
          const rect = (element) => element.getBoundingClientRect();
          const overflowing = [...panel.querySelectorAll('.group-info-meta-row strong')].some(
            (element) =>
              element.scrollWidth > element.clientWidth + 1 ||
              element.scrollHeight > element.clientHeight + 1,
          );
          return {
            overflowing,
            panelOverflow:
              panel.scrollWidth > panel.clientWidth + 1 ||
              panel.scrollHeight > panel.clientHeight + 1,
            pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            contentBottom: rect(panel).bottom <= rect(content).top + content.scrollHeight + 1,
            overviewWidth: rect(overview).width,
            overviewRight: rect(overview).right,
            membersLeft: rect(members).left,
            membersTop: rect(members).top,
            overviewBottom: rect(overview).bottom,
            overviewTop: rect(overview).top,
            background: getComputedStyle(panel).backgroundColor,
            shadow: getComputedStyle(panel).boxShadow,
            border: getComputedStyle(panel).borderTopWidth,
            memberMargin: getComputedStyle(members).marginTop,
            memberHeight: rect(members).height,
            listHeight: rect(list).height,
            listScrollable: list.scrollHeight > list.clientHeight,
          };
        });
        const label = `${sparse ? 'sparse' : 'full'}/${componentStyle}/${theme}/${width}`;
        if (output && !sparse && [1180, 390].includes(width)) {
          await page.screenshot({
            path: resolve(output, `${label.replaceAll('/', '-')}.png`),
            fullPage: true,
          });
          if (width === 390) {
            await page.locator('.member-list-section').scrollIntoViewIfNeeded();
            await page.screenshot({
              path: resolve(output, `${label.replaceAll('/', '-')}-members.png`),
            });
          }
        }
        console.log(label, JSON.stringify(result));
        assert.equal(result.overflowing, false, `${label}: 资料文字被截断`);
        assert.equal(result.panelOverflow, false, `${label}: 群资料面板发生嵌套溢出`);
        assert.equal(result.pageOverflow, false, `${label}: 页面横向溢出`);
        assert.equal(result.contentBottom, true, `${label}: 内容无法滚动到达`);
        assert.equal(result.memberMargin, '0px', `${label}: 残留聊天侧栏间距`);
        assert.equal(result.background, 'rgba(0, 0, 0, 0)', `${label}: 误用弹窗背景`);
        assert.equal(result.shadow, 'none', `${label}: 误用弹窗阴影`);
        assert.equal(result.border, '0px', `${label}: 误用弹窗边框`);
        assert.ok(
          result.memberHeight >= 400 && result.listHeight > 250,
          `${label}: 成员列表被挤压`,
        );
        assert.equal(result.listScrollable, true, `${label}: 成员列表不能独立滚动`);
        if (width > 760) {
          assert.ok(result.membersTop <= result.overviewTop + 1, `${label}: 公告推低成员区`);
          assert.ok(result.overviewRight < result.membersLeft, `${label}: 双栏重叠`);
          assert.ok(result.overviewWidth > 300, `${label}: 群资料列过窄`);
        } else {
          assert.ok(result.membersTop >= result.overviewBottom, `${label}: 单栏顺序错误或重叠`);
        }
      }
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
