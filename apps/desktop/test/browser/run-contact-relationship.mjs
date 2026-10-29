import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_RELATIONSHIP_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-contact-relationship'),
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
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/contact-relationship.html`,
  );
  await page.waitForSelector('[data-relationship="friend"]');
  if (output) await mkdir(output, { recursive: true });
  const cases = [
    ['light', 1280, 'plain', '#075c30'],
    ['dark', 1280, 'grid', '#fff3a1'],
    ['light', 390, 'paper', '#ffffff'],
    ['system', 390, 'dots', '#000000'],
    ['light', 1280, 'wash', '#8b5cf6'],
    ['dark', 390, 'telegram', '#73cab8'],
  ];
  for (const [theme, width, background, accent] of cases) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.evaluate(
      ({ theme, background, accent }) => {
        const store = window.relationshipQa.store.getState();
        store.setAccent(accent);
        store.setBackground(background);
        store.setPreference(theme);
      },
      { theme, background, accent },
    );
    const result = await page.evaluate(() => {
      const badges = [...document.querySelectorAll('.weq-relationship-status')];
      const canvas = document.createElement('canvas').getContext('2d');
      const color = (value) => {
        canvas.fillStyle = value;
        return canvas.fillStyle;
      };
      const tokens = getComputedStyle(document.documentElement);
      const wrongColor = badges.some((badge) => {
        const positive = ['friend', 'member'].includes(badge.getAttribute('data-relationship'));
        return (
          color(getComputedStyle(badge).color) !==
          color(tokens.getPropertyValue(positive ? '--weq-accent-effective' : '--weq-fg-secondary'))
        );
      });
      const clipped = badges.filter((badge) => {
        const rect = badge.getBoundingClientRect();
        return (
          rect.left < 0 || rect.right > innerWidth + 1 || badge.scrollWidth > badge.clientWidth + 1
        );
      });
      const titles = [...document.querySelectorAll('.contact-card-nickname')];
      const overlapping = titles.some((title) => {
        const name = title.querySelector('.row-title-text')?.getBoundingClientRect();
        const badge = title.querySelector('.weq-relationship-status')?.getBoundingClientRect();
        return name && badge && name.right > badge.left + 1;
      });
      return {
        clipped: clipped.length,
        wrongColor,
        overlapping,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        states: badges.map((badge) => badge.getAttribute('data-relationship')),
      };
    });
    if (
      result.clipped ||
      result.wrongColor ||
      result.overlapping ||
      result.overflow ||
      !['friend', 'nonfriend', 'member', 'nonmember'].every((state) =>
        result.states.includes(state),
      )
    )
      throw new Error(`${theme}/${width}/${background}: ${JSON.stringify(result)}`);
    if (output)
      await page.screenshot({
        path: resolve(output, `${theme}-${width}-${background}.png`),
        fullPage: true,
      });
    console.log(`PASS ${theme}/${width}/${background}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser?.close();
  await server.close();
}
