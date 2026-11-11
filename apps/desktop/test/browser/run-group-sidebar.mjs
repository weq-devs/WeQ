import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_GROUP_SIDEBAR_ARTIFACTS ?? '/tmp/weq-qa/shots/group-sidebar';
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-group-sidebar'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/group-sidebar.stub.ts'),
      },
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
const report = { shots: [], metrics: {}, errors: [] };
let browser;
const shot = async (page, name) => {
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path });
  report.shots.push(path);
};
const setTheme = async (page, theme) => {
  await page.evaluate((value) => {
    window.groupSidebarQa.theme.getState().setPreference(value);
    window.groupSidebarQa.theme.getState().setAccent(value === 'light' ? '#075c30' : '#fff3a1');
  }, theme);
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
};
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.route('**/*', (route) =>
    ['127.0.0.1'].includes(new URL(route.request().url()).hostname) ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const base = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/group-sidebar.html`;
  await page.goto(`${base}?view=wide`);
  await page.getByText('群资料', { exact: true }).waitFor();
  await page.waitForTimeout(800);
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    await page.setViewportSize({ width: 1180, height: 900 });
    await shot(page, `sidebar-1180-${theme}`);
    await page.setViewportSize({ width: 390, height: 860 });
    await shot(page, `sidebar-390-${theme}`);
    await page.setViewportSize({ width: 320, height: 780 });
    await shot(page, `sidebar-320-${theme}`);
  }
  await setTheme(page, 'light');
  await page.setViewportSize({ width: 1180, height: 900 });
  report.metrics.panel = await page.evaluate(() => {
    const panel = document.querySelector('.group-info-panel');
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    return {
      panel: box(panel),
      overview: box(document.querySelector('.group-info-overview')),
      memberRows: document.querySelectorAll('.group-info-member-row').length,
      headings: [
        ...document.querySelectorAll(
          '.group-info-panel h3,.group-info-panel h4,.group-info-panel h5',
        ),
      ].map((node) => node.textContent),
      text: panel?.innerText ?? '',
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth,
    };
  });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ shots: report.shots.length, errors: report.errors }));
  console.log(JSON.stringify(report.metrics.panel, null, 1).slice(0, 2000));
} finally {
  await browser?.close();
  await server.close();
}
