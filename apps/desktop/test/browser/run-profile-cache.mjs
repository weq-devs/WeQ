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
  cacheDir: resolve(root, 'node_modules/.vite-profile-cache'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/contact-directory-order.stub.ts'),
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
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-cache.html`;
  await page.goto(url);
  const directory = page.locator('[data-kind="directory"]');
  await directory.getByLabel('分组依据').selectOption('none');
  await directory.getByLabel('排序依据').selectOption('sigUpdateTime');
  const names = () => directory.locator('.contact-row .row-title-text').allTextContents();
  assert.deepEqual(await names(), ['合成联系人b', '合成联系人a', '合成联系人c']);
  await directory.getByRole('button', { name: '改为升序', exact: true }).click();
  assert.deepEqual(await names(), ['合成联系人a', '合成联系人b', '合成联系人c']);
  await directory.getByLabel('分组依据').selectOption('occupation');
  assert.deepEqual(
    new Set(await directory.locator('.contact-cat-name').allTextContents()),
    new Set(['学生', '职业未知']),
  );
  await directory.getByLabel('搜索联系人', { exact: true }).fill('学生');
  assert.equal((await names()).length, 2);
  await directory.getByLabel('搜索联系人', { exact: true }).fill('');
  const profile = page.locator('[data-kind="profile"]');
  assert.ok((await profile.textContent()).includes('签名更新于 2026-11-11 00:01:02'));
  const marks = page.locator('[data-kind="marks"]');
  assert.ok((await marks.textContent()).includes('互动标识 7'));
  await page.evaluate(() => window.profileCacheQa.setMarks('empty'));
  await marks.getByText('暂无互动标识').waitFor();
  assert.ok(!(await marks.textContent()).includes('互动标识 7'));
  await page.evaluate(() => window.profileCacheQa.setMarks('error'));
  await marks.getByText('在线更新失败，显示本地缓存。').waitFor();
  const output = process.env.WEQ_PROFILE_CACHE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1180, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        const state = window.profileCacheQa.store.getState();
        state.setPreference(theme);
        state.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
      }, theme);
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      const labels = page.locator('[data-kind="labels"] details');
      for (const detail of await labels.all())
        if (!(await detail.evaluate((element) => element.open)))
          await detail.locator('summary').tap();
      assert.ok((await labels.first().textContent()).includes('本地设置者备注'));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.equal(
        await labels.evaluateAll((elements) =>
          elements.some((element) => element.scrollWidth > element.clientWidth),
        ),
        false,
      );
      if (output)
        await page.screenshot({ path: resolve(output, `${width}-${theme}.png`), fullPage: true });
    }
  const first = page.locator('[data-kind="labels"] summary').first();
  await first.focus();
  await page.keyboard.press('Enter');
  assert.equal(await first.evaluate((element) => element.parentElement.open), false);
  await page.goto(`${url}?member=1`);
  const member = page.locator('.weq-member-pop');
  await member.waitFor();
  await member.getByText('学生', { exact: true }).waitFor();
  await member.getByText('其他', { exact: true }).waitFor();
  assert.ok((await member.textContent()).includes('2026-11-11 00:01:02'));
  assert.equal(
    await member.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  if (output) await page.screenshot({ path: resolve(output, 'member-320.png') });
  assert.deepEqual(errors, []);
  console.log(
    '职业检索与分组、签名双向排序、好友和群友资料、标签来源、标识缓存更新、六组响应式主题及键盘触屏检查通过',
  );
} finally {
  await browser?.close();
  await server.close();
}
