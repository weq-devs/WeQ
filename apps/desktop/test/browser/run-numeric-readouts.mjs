import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-numeric-readouts'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
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
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/numeric-readouts.html`,
  );
  await page.locator('[data-reference]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const output = process.env.WEQ_NUMERIC_READOUT_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const theme of ['light', 'dark']) {
      for (const accent of ['#006d50', '#df5878']) {
        await page.evaluate(
          ({ theme, accent }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.setProperty('--weq-accent-effective', accent);
          },
          { theme, accent },
        );
        const result = await page.evaluate(() => {
          const bodyFamily = getComputedStyle(document.querySelector('[data-body]')).fontFamily;
          const field = document.querySelector('[data-numeric-input]');
          const fieldStyle = getComputedStyle(field);
          const placeholderStyle = getComputedStyle(field, '::placeholder');
          const readouts = [
            ...document.querySelectorAll(
              '[data-readout], [data-time] time, [data-duration] span, .weq-number:not(.weq-report-root *)',
            ),
          ].map((node) => {
            const style = getComputedStyle(node);
            const parent = getComputedStyle(node.parentElement);
            return {
              text: node.textContent,
              family: style.fontFamily,
              parentFamily: parent.fontFamily,
              sizeAdjust: style.fontSizeAdjust,
              parentSizeAdjust: parent.fontSizeAdjust,
              numeric: style.fontVariantNumeric,
              weight: style.fontWeight,
              expectedWeight: node.classList.contains('weq-number-inherit')
                ? parent.fontWeight
                : node.dataset.weight,
            };
          });
          const probe = document.createElement('span');
          probe.className = 'weq-number';
          probe.style.cssText = 'display:inline-block;position:absolute;visibility:hidden';
          document.body.append(probe);
          const widths = Array.from({ length: 10 }, (_, n) => {
            probe.textContent = String(n).repeat(8);
            return probe.getBoundingClientRect().width;
          });
          probe.remove();
          return {
            bodyFamily,
            inputFamily: fieldStyle.fontFamily,
            inputNumeric: fieldStyle.fontVariantNumeric,
            placeholderFamily: placeholderStyle.fontFamily,
            placeholderAdjust: placeholderStyle.fontSizeAdjust,
            readouts,
            widths,
            labels: [...document.querySelectorAll('[data-label]')].map(
              (node) => getComputedStyle(node).fontFamily,
            ),
            codeFamily: getComputedStyle(document.querySelector('[data-code]')).fontFamily,
            reportFamilies: [
              ...document.querySelectorAll('.weq-report-root .weq-number, .weq-report-root time'),
            ].map((node) => getComputedStyle(node).fontFamily),
            overflow: document.documentElement.scrollWidth > innerWidth,
            taskNumbers: [
              ...document.querySelectorAll('[data-real-task] .weq-long-task-meta .weq-number'),
            ].map((node) => node.textContent),
            taskNameNumeric: document.querySelectorAll(
              '[data-real-task] .weq-long-task-name .weq-number',
            ).length,
            seqWeight: getComputedStyle(document.querySelector('[data-real-seq] .weq-number'))
              .fontWeight,
            performanceNumbers: document.querySelectorAll('[data-real-performance] dd.weq-number')
              .length,
            performanceTextFont: getComputedStyle(
              document.querySelector('[data-real-performance] dd:not(.weq-number)'),
            ).fontFamily,
            svgSpans: document.querySelectorAll('[data-real-svg] span').length,
            svgNumbers: document.querySelectorAll('[data-real-svg] tspan').length,
          };
        });
        assert.ok(result.readouts.length >= 25);
        for (const readout of result.readouts) {
          assert.equal(readout.family, readout.parentFamily, JSON.stringify(readout));
          assert.equal(readout.sizeAdjust, readout.parentSizeAdjust, JSON.stringify(readout));
          assert.ok(readout.numeric.includes('tabular-nums'), JSON.stringify(readout));
          if (readout.expectedWeight)
            assert.equal(readout.weight, readout.expectedWeight, JSON.stringify(readout));
        }
        assert.ok(result.labels.every((family) => family === result.bodyFamily));
        assert.equal(result.inputFamily, result.bodyFamily);
        assert.equal(result.inputNumeric, 'tabular-nums');
        assert.equal(result.placeholderFamily, result.bodyFamily);
        assert.equal(result.placeholderAdjust, 'none');
        assert.match(result.codeFamily, /mono/i);
        assert.ok(result.reportFamilies.every((family) => family.includes('Georgia')));
        assert.ok(Math.max(...result.widths) - Math.min(...result.widths) < 0.1);
        assert.equal(result.overflow, false);
        assert.deepEqual(result.taskNumbers, ['2', '128.5', '256']);
        assert.equal(result.taskNameNumeric, 0);
        assert.equal(result.seqWeight, '700');
        assert.equal(result.performanceNumbers, 3);
        assert.equal(result.performanceTextFont, result.bodyFamily);
        assert.equal(result.svgSpans, 0);
        assert.equal(result.svgNumbers, 2);
        cases++;
      }
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      cases,
      contextualFonts: true,
      weightsPreserved: true,
      proseAndReportUnchanged: true,
      tabularDigits: true,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
