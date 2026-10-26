import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-style-consistency'),
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
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/style-consistency.html`,
  );
  await page.waitForSelector('.weq-ark-security');
  if (output) await mkdir(output, { recursive: true });
  const failures = [];
  const results = [];
  const cases = [
    ['light', 1280, 900, 'plain', '#075c30'],
    ['dark', 1280, 900, 'grid', '#fff3a1'],
    ['light', 390, 844, 'paper', '#ffffff'],
    ['system', 390, 844, 'dots', '#000000'],
    ['light', 1280, 900, 'wash', '#8b5cf6'],
    ['dark', 390, 844, 'telegram', '#73cab8'],
  ];
  for (const [theme, width, height, background, accent] of cases) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.evaluate(
      ({ theme, accent, background }) =>
        window.styleConsistency.setTheme(theme, accent, background),
      { theme, accent, background },
    );
    await page.waitForTimeout(200);
    const checks = await page.evaluate(() => {
      const css = (selector) => getComputedStyle(document.querySelector(selector));
      const rootStyle = getComputedStyle(document.documentElement);
      const pixel = (color) => {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return `#${[...ctx.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')}`;
      };
      const token = (name) => pixel(rootStyle.getPropertyValue(name));
      const color = (selector) => pixel(css(selector).color);
      const bg = (selector) => pixel(css(selector).backgroundColor);
      const detail = [...document.querySelectorAll('.weq-ark-security div')].find(
        (node) => node.textContent === '合成详情',
      );
      const item = css('.group-essence-header');
      return {
        arkBody: pixel(getComputedStyle(detail).color) === token('--weq-fg-primary'),
        flashContrast:
          window.styleConsistency.contrastRatio(
            color('.weq-ft-check-mark'),
            bg('.weq-ft-check input'),
          ) >= 7,
        grayTip:
          document.querySelectorAll('.weq-graytip-accent').length === 2 &&
          [...document.querySelectorAll('.weq-graytip-accent')].every(
            (node) => pixel(getComputedStyle(node).color) === token('--weq-accent-ink'),
          ),
        externalAccent: bg('.weq-extsite-btn') === token('--weq-accent-solid'),
        externalContrast:
          window.styleConsistency.contrastRatio(
            color('.weq-extsite-btn'),
            bg('.weq-extsite-btn'),
          ) >= 7,
        externalSurface: css('.weq-extsite-card').backgroundColor !== 'rgba(255, 255, 255, 0.6)',
        essenceSurface: css('.group-essence-item').backgroundColor !== 'rgba(0, 0, 0, 0)',
        essenceMetadata: color('.group-essence-meta') === token('--weq-fg-muted'),
        essencePlaceholder: color('.group-essence-placeholder') === token('--weq-fg-muted'),
        nestedHeader: item.padding === '0px' && item.borderBottomWidth === '0px',
        outerHeader: css('.group-essence-dialog > header').padding === '16px 18px',
        noOverflow: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    for (const [name, passed] of Object.entries(checks))
      if (!passed) failures.push(`${theme}/${width}/${accent}: ${name}`);
    await page.locator('.group-essence-item').hover();
    const hovered = await page
      .locator('.group-essence-item')
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    if (hovered === 'rgba(0, 0, 0, 0)')
      failures.push(`${theme}/${width}: essence hover background`);
    if (output)
      await page.screenshot({
        path: resolve(output, `${theme}-${width}-${background}.png`),
        fullPage: true,
      });
    results.push({ theme, width, accent, background, checks });
  }
  console.log(JSON.stringify({ results, failures, errors }, null, 2));
  if (failures.length || errors.length) throw new Error([...failures, ...errors].join('\n'));
} finally {
  await browser?.close();
  await server.close();
}
