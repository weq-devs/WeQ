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
  cacheDir: resolve(root, 'node_modules/.vite-settings-control-alignment'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/settings-audit.stub.ts'),
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_ALIGNMENT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  const report = [];
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-audit.html`,
    );
    await page.locator('.weq-settings-nav-item').first().waitFor();
    for (const theme of ['light', 'dark']) {
      for (const skin of ['classic', 'retro']) {
        await page.evaluate(
          ({ theme, skin }) => {
            const store = window.settingsAuditQa.theme.getState();
            store.setPreference(theme);
            store.setComponentStyle(skin);
          },
          { theme, skin },
        );
        const sections = await page.locator('.weq-settings-nav-label').allTextContents();
        for (const section of sections) {
          const back = page.getByRole('button', { name: '返回设置', exact: true });
          if (await back.isVisible()) await back.click();
          await page
            .locator('.weq-settings-nav')
            .getByRole('button', { name: section.trim(), exact: true })
            .click();
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          });
          const result = await page.evaluate(() => {
            const body = document.querySelector('.weq-settings-body');
            const controls =
              'button:not([role="switch"], [role="checkbox"], [role="radio"]),input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="hidden"]),select,.weq-segmented';
            const problems = [];
            let checkedGroups = 0;
            for (const group of body.querySelectorAll('*')) {
              const css = getComputedStyle(group);
              if (!['flex', 'inline-flex', 'grid', 'inline-grid'].includes(css.display)) continue;
              // 复合输入框中的尾部工具位属于输入框内部，并非两个并列外框。
              if (
                group.matches(
                  '.weq-set-keyfield,.weq-set-tokenfield,.weq-onebot-token-input,.weq-provider-model-row',
                )
              )
                continue;
              const children = [...group.children].filter(
                (el) => el.matches(controls) && el.getBoundingClientRect().width > 0,
              );
              if (children.length < 2) continue;
              checkedGroups++;
              const boxes = children.map((el) => {
                const b = el.getBoundingClientRect();
                return {
                  name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20),
                  x: b.left,
                  y: b.top,
                  w: b.width,
                  h: b.height,
                };
              });
              const column = css.display.includes('flex') && css.flexDirection.startsWith('column');
              for (let i = 0; i < boxes.length; i++)
                for (const b of boxes.slice(i + 1)) {
                  const a = boxes[i];
                  const overlaps = Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y) + 1;
                  if (
                    column
                      ? Math.abs(a.w - b.w) > 0.5 || Math.abs(a.x - b.x) > 0.5
                      : overlaps && (Math.abs(a.h - b.h) > 0.5 || Math.abs(a.y - b.y) > 0.5)
                  )
                    problems.push({ group: group.className, a, b });
                }
            }
            return { checkedGroups, problems, overflow: body.scrollWidth > body.clientWidth };
          });
          report.push({
            width,
            theme,
            skin,
            group: group.trim(),
            section: section.trim(),
            ...result,
          });
        }
      }
    }
  }
  if (output)
    await writeFile(
      resolve(output, 'settings-report.json'),
      JSON.stringify({ report, errors }, null, 2),
    );
  const failures = report.filter((item) => item.problems.length || item.overflow);
  console.log(
    JSON.stringify(
      {
        cases: report.length,
        groups: report.reduce((sum, item) => sum + item.checkedGroups, 0),
        failures: failures.slice(0, 12),
        failureCount: failures.length,
        errors,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  assert.equal(failures.length, 0, '设置页并列控件应对齐且不溢出');
} finally {
  await browser?.close();
  await server.close();
}
