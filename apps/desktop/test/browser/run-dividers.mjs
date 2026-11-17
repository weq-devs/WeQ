import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_DIVIDER_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-dividers'),
  plugins: [react(), tailwind()],
  optimizeDeps: { entries: ['test/browser/dividers.html'] },
  resolve: {
    alias: [
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
    executablePath: process.env.WEQ_BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/dividers.html`,
  );
  await page.locator('[data-temporary]').waitFor();
  if (output) await mkdir(output, { recursive: true });
  const failures = [];
  let cases = 0;
  for (const width of [1180, 390])
    for (const theme of ['light', 'dark', 'system'])
      for (const style of ['classic', 'qqnt', 'minimal', 'retro'])
        for (const accent of ['#075c30', '#ffffff', '#000000'])
          for (const background of ['plain', 'paper', 'grid', 'dots', 'wash', 'telegram']) {
            await page.setViewportSize({ width, height: 1000 });
            await page.emulateMedia({
              colorScheme: theme === 'light' ? 'light' : 'dark',
              reducedMotion: 'reduce',
            });
            await page.evaluate(
              ({ theme, style, accent, background, width }) => {
                document.documentElement.dataset.weqLayout = width < 600 ? 'single' : 'split';
                const s = window.dividerQa.getState();
                s.setPreference(theme);
                s.setComponentStyle(style);
                s.setAccent(accent);
                s.setBackground(background);
              },
              { theme, style, accent, background, width },
            );
            const result = await page.evaluate(() => {
              const expected = getComputedStyle(
                document.querySelector('.qa-reference'),
              ).borderTopColor;
              const lines = [
                ...document.querySelectorAll('[data-divider-edge], [data-divider-fill]'),
              ].map((node) => {
                const s = getComputedStyle(node);
                const edge = node.dataset.dividerEdge;
                return {
                  selector: node.className,
                  color: edge ? s.getPropertyValue(`border-${edge}-color`) : s.backgroundColor,
                  width: edge ? s.getPropertyValue(`border-${edge}-width`) : s.height,
                  style: edge ? s.getPropertyValue(`border-${edge}-style`) : 'solid',
                };
              });
              const temporary = getComputedStyle(document.querySelector('[data-temporary]'));
              const month = getComputedStyle(
                document.querySelector('[data-month-label]'),
                '::after',
              );
              const time = getComputedStyle(document.querySelector('[data-time-label]'));
              const resize = getComputedStyle(document.querySelector('.sidebar-resize'));
              const wallet = getComputedStyle(document.querySelector('[data-wallet]'));
              return {
                expected,
                lines,
                temporary: temporary.borderTopStyle,
                month: { color: month.backgroundColor, height: month.height, flex: month.flexGrow },
                timeBorder: time.borderTopWidth,
                resizeCursor: resize.cursor,
                wallet: wallet.borderTopColor,
                retroShadow: getComputedStyle(document.querySelector('.sidebar-header')).boxShadow,
                overflow: document.documentElement.scrollWidth > innerWidth,
              };
            });
            const label = `${width}/${theme}/${style}/${accent}/${background}`;
            for (const line of result.lines) {
              const omitted =
                (width === 390 && line.selector === 'sidebar-header qa-sample') ||
                (width === 1180 && line.selector === 'tools-row qa-sample');
              if (omitted) {
                assert.equal(line.width, '0px', `${label}: ${line.selector} 不增加原本省略的线`);
              } else if (
                line.color !== result.expected ||
                line.width !== '1px' ||
                line.style !== 'solid'
              )
                failures.push({ label, expected: result.expected, ...line });
            }
            assert.equal(result.temporary, 'dashed', `${label}: 临时确认保留虚线`);
            assert.deepEqual(
              result.month,
              { color: result.expected, height: '1px', flex: '1' },
              `${label}: 月份标记`,
            );
            assert.equal(result.timeBorder, '0px', `${label}: 时间标记不增加横线`);
            assert.equal(result.resizeCursor, 'col-resize', `${label}: 保留拖拽分栏`);
            assert.equal(
              result.wallet,
              'rgba(255, 255, 255, 0.12)',
              `${label}: 钱包卡片保持专用颜色`,
            );
            if (style === 'retro')
              assert.notEqual(result.retroShadow, 'none', `${label}: 保留复古立体效果`);
            assert.equal(result.overflow, false, `${label}: 页面不横向溢出`);
            if (output && theme !== 'system' && accent === '#075c30' && background === 'plain')
              await page.screenshot({
                path: resolve(output, `${width}-${theme}-${style}.png`),
                fullPage: true,
              });
            cases++;
          }
  console.log(
    JSON.stringify(
      { cases, failureCount: failures.length, failures: failures.slice(0, 20), errors },
      null,
      2,
    ),
  );
  assert.equal(failures.length, 0, '存在未统一的普通分割线，详情见上方摘要');
  await page.getByText('QQ 在线能力对照', { exact: true }).click();
  assert.equal(
    await page.locator('.weq-full-function-comparison-details').getAttribute('open'),
    '',
  );
  await page.getByText('查看读取说明', { exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.weq-set-details').first().getAttribute('open'), '');
  assert.deepEqual(errors, []);
  console.log('折叠说明的鼠标与键盘展开通过。');
} finally {
  await browser?.close();
  await server.close();
}
