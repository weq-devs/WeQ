import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-button-alignment'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/relation-profile.stub.ts'),
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
  const output = process.env.WEQ_ALIGNMENT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const report = [];
  const errors = [];
  for (const touch of [false, true]) {
    const context = await browser.newContext({ hasTouch: touch, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/button-alignment.html`,
    );
    await page.getByRole('button', { name: /查看群交集/ }).click();
    for (const width of [320, 390, 768, 1180]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        for (const skin of ['classic', 'minimal', 'retro', 'qqnt']) {
          await page.evaluate(
            ({ theme, skin }) => {
              const store = window.buttonAlignmentTheme.getState();
              store.setPreference(theme);
              store.setComponentStyle(skin);
              store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
              store.setBackground(theme === 'light' ? 'grid' : 'telegram');
            },
            { theme, skin },
          );
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          });
          const problems = await page.evaluate(() => {
            const problems = [];
            const box = (el) => {
              const r = el.getBoundingClientRect();
              return { left: r.left, top: r.top, width: r.width, height: r.height };
            };
            for (const group of document.querySelectorAll('[data-alignment]')) {
              // 垂直居中但高度不同的按钮会产生不同 top，按垂直投影判断是否同行。
              const boxes = [
                ...group.querySelectorAll(
                  ':scope > button, :scope > input, :scope > select, :scope > .weq-segmented',
                ),
              ]
                .filter((el) => el.getBoundingClientRect().width > 0)
                .map(box);
              if (
                boxes.some((a, i) =>
                  boxes
                    .slice(i + 1)
                    .some(
                      (b) =>
                        Math.min(a.top + a.height, b.top + b.height) > Math.max(a.top, b.top) + 1 &&
                        (Math.abs(a.height - b.height) > 0.5 || Math.abs(a.top - b.top) > 0.5),
                    ),
                )
              )
                problems.push(`${group.dataset.alignment}: ${JSON.stringify(boxes)}`);
            }
            const outer = [...document.querySelector('.weq-graph-overlay-bar').children].map(box);
            if (
              Math.max(...outer.map((b) => b.height)) - Math.min(...outer.map((b) => b.height)) >
              0.5
            )
              problems.push(`关系图谱: ${JSON.stringify(outer)}`);
            for (const group of document.querySelectorAll('[data-alignment-column]')) {
              const sizes = [
                ...group.querySelectorAll(':scope > button, :scope > .weq-segmented'),
              ].map(box);
              if (
                Math.max(...sizes.map((b) => b.width)) - Math.min(...sizes.map((b) => b.width)) >
                0.5
              )
                problems.push(`纵向操作: ${JSON.stringify(sizes)}`);
            }
            if (document.documentElement.scrollWidth > innerWidth) problems.push('页面横向溢出');
            return problems;
          });
          report.push({ touch, width, theme, skin, problems });
          if (output && skin === 'classic' && !touch)
            await page.screenshot({
              path: resolve(output, `${width}-${theme}.png`),
              fullPage: true,
            });
          if (output && skin === 'classic' && !touch)
            await page.locator('.weq-graph-overlay-bar').screenshot({
              path: resolve(output, `${width}-${theme}-toolbar.png`),
            });
        }
      }
    }
    await context.close();
  }
  if (output)
    await writeFile(resolve(output, 'report.json'), JSON.stringify({ report, errors }, null, 2));
  const failures = report.filter((item) => item.problems.length);
  console.log(
    JSON.stringify(
      {
        cases: report.length,
        failures: failures.slice(0, 4),
        failureCount: failures.length,
        errors,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  assert.equal(failures.length, 0, '同组按钮尺寸应对齐');
} finally {
  await browser?.close();
  await server.close();
}
