import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { QQ_REGIONS } from '../../../../packages/protocol/src/oidb/profile/editable-profile.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_REGION_QA;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-profile-region'),
  plugins: [
    react(),
    tailwind(),
    {
      name: 'profile-region-directory',
      configureServer(server) {
        server.middlewares.use('/__region-qa', (_request, response) => {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(QQ_REGIONS));
        });
      },
    },
  ],
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
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-region.html`;
  await page.goto(url);
  await page.getByLabel('当前地区省', { exact: true }).selectOption('0');
  assert.equal(await page.getByLabel('当前地区市', { exact: true }).inputValue(), '0');
  assert.equal(await page.getByLabel('当前地区市', { exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '保存当前地区', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.profileRegionQa.saved[0]), {
    field: 'region',
    value: ['1', '0', '0'],
  });
  assert.equal(await page.getByLabel('家乡省', { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('家乡市', { exact: true }).isEnabled(), true);
  await page.getByLabel('家乡国家', { exact: true }).selectOption('0');
  await page.getByRole('button', { name: '保存家乡', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.profileRegionQa.saved[1]), {
    field: 'hometown',
    value: ['0', '0', '0', '0'],
  });
  if (output) await mkdir(output, { recursive: true });
  const cases = [];
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 740 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#ce809d' : '#167d67',
        );
      }, theme);
      const overflow = await page.evaluate(() =>
        [...document.querySelectorAll('main, .weq-set-row, .weq-profile-region-editor')].some(
          (element) => element.scrollWidth > element.clientWidth + 2,
        ),
      );
      assert.equal(overflow, false, `${width}/${theme}: overflow`);
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      cases.push({ width, theme, overflow });
    }
  assert.deepEqual(errors, []);
  if (output)
    await writeFile(
      resolve(output, 'result.json'),
      JSON.stringify({ cases, errors, writes: 'fixture-only' }, null, 2),
    );
  console.log(JSON.stringify({ cases: cases.length, errors, writes: 'fixture-only' }));
} finally {
  await browser?.close();
  await server.close();
}
