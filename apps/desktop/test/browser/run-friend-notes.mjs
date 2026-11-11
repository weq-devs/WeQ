import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_FRIEND_NOTES_QA;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-friend-notes'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/friend-notes.stub.ts'),
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
  if (output) await mkdir(output, { recursive: true });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/friend-notes.html`,
  );
  const toggle = page.getByRole('button', { name: '我的备注资料', exact: true });
  await toggle.waitFor();
  assert.equal(await page.evaluate(() => window.friendNotesQa.requests()), 0);
  await toggle.click();
  await page.getByRole('textbox', { name: '我备注的公司', exact: true }).waitFor();
  assert.equal(
    await page.getByText('我为好友添加的备注，不是好友公开资料。', { exact: true }).count(),
    1,
  );
  const cases = [];
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#167d67' : '#db7aa4',
        );
      }, theme);
      const overflow = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '.weq-qq-remark-dialog, .weq-friend-notes, .weq-friend-notes-item',
          ),
        ]
          .filter((el) => el.scrollWidth > el.clientWidth + 2)
          .map((el) => el.className),
      );
      assert.deepEqual(overflow, [], `${width}/${theme}`);
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      cases.push({ width, theme, overflow: false });
    }
  await page.getByRole('textbox', { name: '我备注的公司', exact: true }).fill('新的合成公司备注');
  await page.getByRole('button', { name: '添加我备注的电话', exact: true }).click();
  await page.getByRole('textbox', { name: '我备注的电话 3', exact: true }).fill('12345');
  await page.getByRole('button', { name: '保存我的备注资料', exact: true }).click();
  await page.waitForFunction(() => window.friendNotesQa.writes() === 1);
  await page
    .getByRole('button', { name: '保存我的备注资料', exact: true })
    .waitFor({ state: 'visible' });
  assert.equal(
    await page.getByRole('textbox', { name: '我备注的电话 3', exact: true }).inputValue(),
    '12345',
  );
  await page.evaluate(() => window.friendNotesQa.fail(true));
  await page.getByRole('alert').waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '我备注的公司', exact: true }).isDisabled(),
    true,
  );
  await page.evaluate(() => window.friendNotesQa.fail(false));
  await page.getByRole('button', { name: '刷新我的备注资料', exact: true }).click();
  assert.deepEqual(errors, []);
  if (output)
    await writeFile(
      resolve(output, 'result.json'),
      JSON.stringify(
        {
          cases,
          errors,
          lazyRead: true,
          listSave: true,
          errorDisablesWrite: true,
          writes: 'synthetic-only',
        },
        null,
        2,
      ),
    );
  console.log(
    JSON.stringify({
      cases: cases.length,
      errors,
      lazyRead: true,
      listSave: true,
      errorDisablesWrite: true,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
