import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_DISPLAY_QA;
const stub = resolve(root, 'test/browser/profile-display.stub.ts');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-profile-display'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/hooks\/useQQWriteSession$/, replacement: stub },
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
const results = [];
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
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-display.html`,
  );
  const modeButton = page.locator('[data-profile-display-mode]');
  await page.getByRole('button', { name: '编辑性别', exact: true }).waitFor();
  assert.equal(await modeButton.count(), 0);
  assert.equal(await page.getByRole('switch').count(), 0);
  assert.equal(await page.evaluate(() => window.profileDisplayQa.calls()), 0);
  await page.getByRole('button', { name: '编辑性别', exact: true }).click();
  assert.ok((await page.locator('main').textContent()).includes('合成名片昵称'));
  assert.equal(
    await page.locator('[data-display-field="gender"] [aria-checked="true"]').count(),
    0,
  );
  await page.locator('[data-display-field="gender"] [aria-checked="true"]').waitFor();
  assert.equal(await page.evaluate(() => window.profileDisplayQa.calls()), 1);
  const gender = page.locator('[data-display-field="gender"]');
  await gender.getByRole('radio', { name: '仅好友', exact: true }).click();
  assert.equal(await page.evaluate(() => window.profileDisplayQa.writes()), 0);
  await page.getByRole('button', { name: '保存性别', exact: true }).click();
  await page.getByRole('button', { name: '编辑性别', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.profileDisplayQa.writes()), 1);
  await page.evaluate(() => window.profileDisplayQa.mismatch(true));
  await page.getByRole('button', { name: '编辑性别', exact: true }).click();
  await gender.getByRole('radio', { name: '不可见', exact: true }).click();
  await page.getByRole('button', { name: '保存性别', exact: true }).click();
  await gender.getByText('读回状态与选择不一致，请重新读取核对').waitFor();
  assert.equal(
    await gender.getByRole('radio', { name: '不可见', exact: true }).getAttribute('aria-checked'),
    'true',
  );
  await gender.getByRole('button', { name: '重新读取性别展示设置' }).click();
  await page.waitForFunction(() => window.profileDisplayQa.calls() === 2);
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: '取消编辑性别', exact: true }).click();
  await page.getByRole('button', { name: '编辑公司', exact: true }).click();
  const education = page.locator('[data-display-field="company"]');
  assert.equal(await education.count(), 1);
  await page.evaluate(() => window.profileDisplayQa.mismatch(false));
  await education.first().getByRole('radio', { name: '不可见', exact: true }).click();
  await page.getByRole('button', { name: '保存公司', exact: true }).click();
  await page.getByRole('button', { name: '编辑公司', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑公司', exact: true }).click();
  await page.getByRole('button', { name: '编辑性别', exact: true }).click();
  assert.equal(await education.locator('[aria-checked="true"]').count(), 1);
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark'])
      for (const background of ['plain', 'paper']) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
        await page.evaluate(
          ({ theme, background }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.dataset.background = background;
            document.documentElement.style.setProperty(
              '--weq-accent-effective',
              theme === 'dark' ? '#85d0a6' : '#a12757',
            );
            document.documentElement.style.setProperty(
              '--weq-accent-on',
              theme === 'dark' ? '#101412' : '#ffffff',
            );
          },
          { theme, background },
        );
        const overflow = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              'main, .weq-profile-display-field, .weq-profile-display-control, .weq-profile-display-entry',
            ),
          ]
            .filter((element) => element.scrollWidth > element.clientWidth + 2)
            .map((element) => element.className),
        );
        assert.deepEqual(overflow, [], `${width}/${theme}/${background}`);
        if (output && background === 'plain')
          await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
        results.push({ width, theme, background, overflow });
      }
  await page.getByRole('button', { name: '取消编辑性别', exact: true }).click();
  await page.getByRole('button', { name: '取消编辑公司', exact: true }).click();
  assert.equal(await page.locator('[data-display-field]').count(), 0);
  await page.getByRole('button', { name: '编辑性别', exact: true }).click();
  await gender.getByRole('radio', { name: '仅好友', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => window.profileDisplayQa.writes()), 3);
  assert.equal(
    await gender.getByRole('radio', { name: '不可见', exact: true }).getAttribute('aria-checked'),
    'true',
  );
  await page.getByRole('button', { name: '保存性别', exact: true }).click();
  await page.getByRole('button', { name: '编辑性别', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.profileDisplayQa.writes()), 4);
  assert.deepEqual(errors, []);
  if (output)
    await writeFile(resolve(output, 'result.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ cases: results.length, errors }));
} finally {
  await browser?.close();
  await server.close();
}
