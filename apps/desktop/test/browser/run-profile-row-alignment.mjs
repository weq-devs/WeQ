import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_ROW_ARTIFACTS;
const sectionsOnly = process.argv.includes('--sections-only');
const server = await createServer({
  configFile: false,
  root,
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    ['127.0.0.1'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1180]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      if (!sectionsOnly) {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-row-alignment.html`,
        );
        await page.locator('.weq-profile-data-row').first().waitFor();
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty(
            '--weq-accent-effective',
            theme === 'dark' ? '#47bc97' : '#c64556',
          );
        }, theme);
        const rows = await page.locator('.weq-profile-data-row').evaluateAll((rows) => {
          const firstTextRect = (element) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (!node.textContent.trim()) continue;
              const range = document.createRange();
              range.setStart(node, 0);
              range.setEnd(node, 1);
              const rect = range.getBoundingClientRect();
              return { center: rect.top + rect.height / 2 };
            }
            return null;
          };
          return rows.map((row) => {
            const label = row.querySelector('.weq-profile-data-label');
            const value = row.querySelector('.weq-profile-data-value');
            const labelText = firstTextRect(label);
            const valueText = firstTextRect(value);
            return {
              label: label.textContent,
              textOffset: valueText ? Math.abs(labelText.center - valueText.center) : null,
              topOffset: Math.abs(
                label.getBoundingClientRect().top - value.getBoundingClientRect().top,
              ),
              overflow: row.scrollWidth > row.clientWidth + 1,
            };
          });
        });
        for (const row of rows) {
          const name = `${width}/${theme}/${row.label}`;
          assert.ok(row.topOffset < 1, `${name}: 内容未从首行开始 ${JSON.stringify(row)}`);
          if (row.textOffset !== null)
            assert.ok(row.textOffset < 1, `${name}: 未与第一行文字居中对齐 ${JSON.stringify(row)}`);
          assert.equal(row.overflow, false, `${name}: 横向溢出`);
        }
        if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      }
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-row-alignment.html?sections`,
      );
      await page.locator('[data-section-fixture]').last().waitFor();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#47bc97' : '#c64556',
        );
      }, theme);
      const sections = await page.locator('[data-section-fixture]').evaluateAll((fixtures) =>
        fixtures.map((fixture) => {
          const bot = fixture.querySelector('[data-profile-anchor="bot"]');
          const style = getComputedStyle(bot);
          return {
            surface: fixture.className,
            preceding: fixture.dataset.preceding === 'true',
            border: Number.parseFloat(style.borderTopWidth),
            padding: Number.parseFloat(style.paddingTop),
            visible: bot.getBoundingClientRect().height > 0,
          };
        }),
      );
      assert.equal(sections.length, 12);
      for (const section of sections) {
        const name = `${width}/${theme}/${JSON.stringify(section)}`;
        assert.equal(section.visible, true, `${name}: 机器人信息应正常显示`);
        assert.equal(section.border, section.preceding ? 1 : 0, `${name}: 分隔线数量错误`);
        if (!section.preceding)
          assert.equal(section.padding, 0, `${name}: 首个可见分区不应保留分隔线上方间距`);
      }
      if (output)
        await page.screenshot({
          path: resolve(output, `${width}-${theme}-sections.png`),
          fullPage: true,
        });
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ cases, rows: sectionsOnly ? 0 : 7, sectionCases: cases * 12, errors }),
  );
} finally {
  await browser?.close();
  await server.close();
}
