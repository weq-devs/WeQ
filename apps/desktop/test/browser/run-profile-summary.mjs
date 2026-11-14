import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_APPROVED_QA;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-profile-summary'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/profile-summary.stub.ts'),
      },
      {
        find: /^.*\/hooks\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/profile-summary.stub.ts'),
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
let browser;
const checks = [],
  errors = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-summary.html`,
  );
  await page.getByRole('button', { name: '打开完整资料页', exact: true }).click();
  await page.getByText('家乡', { exact: true }).waitFor();
  const otherHometown = await page
    .locator('.weq-profile-data-row')
    .filter({ has: page.getByText('家乡', { exact: true }) })
    .locator('.weq-profile-data-value')
    .innerText();
  assert.ok(otherHometown.includes('福建'));
  assert.equal(
    await page.evaluate(() =>
      window.profileApprovedQa.calls.includes('account.profileExtras.medalWall'),
    ),
    false,
  );
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.getByRole(width > 760 ? 'button' : 'tab', { name: '勋章墙', exact: true }).click();
      await page.getByText('12 枚', { exact: true }).waitFor();
      assert.equal(await page.getByText('新获勋章', { exact: true }).count(), 1);
      const overflow = await page.evaluate(() =>
        [...document.querySelectorAll('.weq-profile-data-row, .weq-profile-medal-link')].some(
          (node) => node.scrollWidth > node.clientWidth + 2,
        ),
      );
      assert.equal(overflow, false);
      if (output)
        await page.screenshot({ path: `${output}/medals-${width}-${theme}.png`, fullPage: true });
      checks.push({ view: 'medals', width, theme });
    }
  await page.evaluate(() => {
    window.contactCardQa.mode = 'nonfriend';
    window.contactCardQa.notify();
  });
  await page.getByRole('tab', { name: '与我的关系', exact: true }).click();
  await page.getByText('共同兴趣', { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('region', { name: '与我的关系', exact: true })
      .getByText('合成学校', { exact: false })
      .count(),
    1,
  );
  if (output) await page.screenshot({ path: `${output}/common-320-dark.png`, fullPage: true });
  checks.push({ view: 'common', width: 320, theme: 'dark' });
  await page.evaluate(() => {
    window.profileApprovedQa.state = 'empty';
    window.contactCardQa.notify();
  });
  await page.getByText('暂无可展示的共同点', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.profileApprovedQa.state = 'error';
    window.contactCardQa.notify();
  });
  await page.getByText('刷新失败，已有内容保留。', { exact: true }).waitFor();
  await page
    .getByRole('region', { name: '与我的关系', exact: true })
    .locator('.weq-profile-inline-error button')
    .click();
  await page.getByText('共同兴趣', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.contactCardQa.mode = 'self';
    window.contactCardQa.notify();
  });
  await page.getByRole('tab', { name: '个人资料', exact: true }).click();
  await page.getByText('家乡', { exact: true }).waitFor();
  const selfHometown = await page
    .locator('.weq-profile-data-row')
    .filter({ has: page.getByText('家乡', { exact: true }) })
    .locator('.weq-self-field-value')
    .innerText();
  assert.equal(selfHometown.trim(), otherHometown.trim());
  checks.push({ view: 'hometown', sameFormat: true, text: selfHometown });
  assert.deepEqual(errors, []);
  if (output) await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, errors }));
} finally {
  await browser?.close();
  await server.close();
}
