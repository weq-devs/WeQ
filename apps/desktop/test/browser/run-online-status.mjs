import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_ONLINE_STATUS_ARTIFACTS;
const image = await readFile(resolve(root, '../../resources/brand/logo.png'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-online-status'),
  plugins: [
    react(),
    tailwind(),
    {
      name: 'synthetic-avatars',
      configureServer(server) {
        server.middlewares.use('/_avatar/', (_req, res) => {
          res.setHeader('Content-Type', 'image/png');
          res.end(image);
        });
      },
    },
  ],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/online-status.stub.ts'),
      },
      {
        find: /^.*\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/online-status.stub.ts'),
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 770, 1180])
    for (const theme of ['light', 'dark'])
      for (const self of [false, true]) {
        await page.setViewportSize({ width, height: 850 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        const params = new URLSearchParams({ popover: '' });
        if (!self) params.set('other', '');
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/self-profile.html?${params}`,
        );
        await page.locator('.weq-contact-title-line').waitFor();
        for (const text of [
          '太阳该是什么颜色',
          '很长的自定义状态文案'.repeat(8),
          'LongStatus'.repeat(16),
        ]) {
          await page.evaluate(
            async ({ text, theme }) => {
              const { client } = await import('/test/browser/self-profile.stub.ts');
              await client.account.qqWrite.onlineStatus.mutate({
                patch: { nickname: '合成昵称' },
                status: 10,
                extStatus: 2000,
                custom: { faceId: 74, faceType: 1, wording: text },
              });
              document.documentElement.dataset.theme = theme;
              document.documentElement.style.setProperty(
                '--weq-accent-effective',
                theme === 'light' ? '#075c30' : '#fff3a1',
              );
            },
            { text, theme },
          );
          const heading = page.locator('.weq-contact-title-line');
          await heading.getByText(text, { exact: true }).waitFor();
          const metrics = await heading.evaluate((element) => {
            const base = [...element.querySelectorAll('span')].find(
              (span) => span.textContent === '在线' && span.childNodes.length === 1,
            );
            const range = document.createRange();
            range.selectNodeContents(base);
            const lines = [...range.getClientRects()];
            const status = base.closest('.weq-online-status') || base.parentElement;
            const natural = status.cloneNode(true);
            Object.assign(natural.style, {
              position: 'fixed',
              width: 'max-content',
              maxWidth: 'none',
              whiteSpace: 'nowrap',
            });
            for (const child of natural.querySelectorAll('*')) child.style.whiteSpace = 'nowrap';
            status.parentElement.append(natural);
            const naturalWidth = natural.getBoundingClientRect().width;
            natural.remove();
            const statusBox = status.getBoundingClientRect();
            const headingBox = element.getBoundingClientRect();
            const walker = document.createTreeWalker(status, NodeFilter.SHOW_TEXT);
            const textTops = new Set();
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              range.selectNodeContents(node);
              for (const rect of range.getClientRects()) textTops.add(Math.round(rect.top));
            }
            return {
              baseLines: lines.length,
              textLines: Math.max(...textTops) - Math.min(...textTops) < 8 ? 1 : 2,
              naturalWidth,
              available: headingBox.width,
              overflow: statusBox.right > headingBox.right + 1,
              horizontalScroll: document.documentElement.scrollWidth > innerWidth + 1,
            };
          });
          const label = `${width}-${theme}-${self ? 'self' : 'friend'}-${text.length}`;
          if (output && text.length < 20)
            await page.screenshot({ path: resolve(output, `${label}.png`) });
          assert.equal(metrics.baseLines, 1, `${label}: 基础状态被拆行`);
          if (metrics.naturalWidth <= metrics.available)
            assert.equal(metrics.textLines, 1, `${label}: 空间充足时状态仍换行`);
          assert.equal(metrics.overflow, false, `${label}: 状态超出标题区`);
          assert.equal(metrics.horizontalScroll, false, label);
          if (self) {
            const trigger = page.getByRole('button', { name: '编辑在线状态', exact: true });
            await trigger.click();
            await page.getByRole('dialog', { name: '修改在线状态', exact: true }).waitFor();
            await page.getByRole('button', { name: '关闭在线状态', exact: true }).click();
          } else {
            assert.equal(await page.getByRole('button', { name: '编辑在线状态' }).count(), 0);
          }
          cases++;
        }
      }
  for (const surface of ['titlebar', 'mobile-header'])
    for (const width of surface === 'titlebar' ? [800, 1180] : [320, 390])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 850 });
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/self-profile.html?${surface}`,
        );
        await page.evaluate(
          async ({ surface, theme }) => {
            const { client } = await import('/test/browser/self-profile.stub.ts');
            await client.account.qqWrite.onlineStatus.mutate({
              status: 10,
              extStatus: 2000,
              custom: { faceId: 74, faceType: 1, wording: '很长的自定义状态文案'.repeat(8) },
            });
            document.documentElement.dataset.theme = theme;
            document.documentElement.dataset.weqLayout =
              surface === 'mobile-header' ? 'single' : 'split';
          },
          { surface, theme },
        );
        const status = page.locator('.weq-online-status');
        await status
          .getByText('很长的自定义状态文案'.repeat(8), { exact: true })
          .waitFor({ state: 'attached' });
        const metrics = await status.evaluate((element) => {
          const text = element.querySelector('.weq-online-status-text');
          const icon = element.querySelector('.weq-online-status-icon');
          const style = getComputedStyle(text);
          return {
            wrapping: style.whiteSpace,
            ellipsis: style.textOverflow,
            clipped: text.scrollWidth > text.clientWidth,
            iconWidth: icon.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
          };
        });
        const label = `${width}-${theme}-${surface}`;
        assert.equal(metrics.wrapping, 'nowrap', label);
        assert.equal(metrics.ellipsis, 'ellipsis', label);
        assert.equal(metrics.clipped, true, label);
        assert.equal(metrics.iconWidth, 16, label);
        assert.ok(metrics.height <= 20, `${label}: 紧凑状态出现多行`);
        if (output) await page.screenshot({ path: resolve(output, `${label}.png`) });
        cases++;
      }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
