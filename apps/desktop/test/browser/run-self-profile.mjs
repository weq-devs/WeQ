import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_SELF_PROFILE_QA;
const image = await readFile(resolve(root, '../../resources/brand/logo.png'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-self-profile'),
  plugins: [
    react(),
    tailwind(),
    {
      name: 'synthetic-avatars',
      configureServer(server) {
        server.middlewares.use('/_avatar/', (_req, res) => {
          res.setHeader('Content-Type', 'image/png');
          res.end(image);
        });
      },
    },
  ],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/self-profile.stub.ts'),
      },
      {
        find: /^.*\/hooks\/useQQWriteSession$/,
        replacement: resolve(root, 'test/browser/self-profile.stub.ts'),
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
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/self-profile.html`;
  await page.goto(url);
  await page.getByRole('button', { name: '查看资料', exact: true }).waitFor();
  assert.equal(
    await page.locator('input, textarea, select').count(),
    0,
    'default card is read-only',
  );
  assert.equal(
    await page.getByRole('button', { name: '编辑QQ 昵称', exact: true }).count(),
    0,
    'editing is absent from card',
  );
  assert.equal(
    await page.evaluate(() => window.selfProfileQa.requests()),
    0,
    'no eager history query',
  );
  if (output) await page.screenshot({ path: resolve(output, 'readonly-card.png') });
  await page.getByRole('button', { name: '查看资料', exact: true }).click();
  await page.getByRole('button', { name: '编辑QQ 昵称', exact: true }).click();
  await page.getByRole('textbox', { name: 'QQ 昵称', exact: true }).fill('新的合成昵称');
  await page.evaluate(() => window.selfProfileQa.failSave(true));
  await page.getByRole('button', { name: '保存QQ 昵称', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: 'QQ 昵称', exact: true }).inputValue(),
    '新的合成昵称',
  );
  await page.getByRole('button', { name: '取消编辑QQ 昵称', exact: true }).click();
  await page.evaluate(() => window.selfProfileQa.failSave(false));
  await page.getByRole('button', { name: '编辑QQ 昵称', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: 'QQ 昵称', exact: true }).inputValue(),
    '合成名片昵称',
  );
  await page.getByRole('textbox', { name: 'QQ 昵称', exact: true }).fill('已保存合成昵称');
  await page.getByRole('button', { name: '保存QQ 昵称', exact: true }).click();
  await page.getByRole('button', { name: '编辑QQ 昵称', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑公司', exact: true }).click();
  await page.getByRole('textbox', { name: '公司', exact: true }).fill('');
  await page.getByRole('button', { name: '保存公司', exact: true }).click();
  await page.getByRole('button', { name: '编辑公司', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑个人说明', exact: true }).click();
  await page
    .getByRole('textbox', { name: '个人说明', exact: true })
    .fill('多行个人说明\n保留换行后的第二行');
  await page.getByRole('button', { name: '保存个人说明', exact: true }).click();
  await page.getByRole('button', { name: '编辑个人说明', exact: true }).waitFor();
  await page.getByText('多行个人说明', { exact: false }).waitFor();
  const results = [];
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
      const overflow = () =>
        page.evaluate(() =>
          [
            ...document.querySelectorAll(
              '.weq-self-profile-dialog, .weq-self-field-display, .weq-avatar-history-dialog, .weq-avatar-history-grid article',
            ),
          ]
            .filter((el) => el.scrollWidth > el.clientWidth + 2)
            .map((el) => el.className),
        );
      assert.deepEqual(await overflow(), [], `${width}/${theme}: card overflow`);
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-card.png`) });
      await page.getByRole('button', { name: '历史头像', exact: true }).click();
      await page.getByText('共 4 个头像', { exact: true }).waitFor();
      const dates = () => page.locator('.weq-avatar-history-grid article dl').allTextContents();
      assert.ok((await dates())[0].includes('2001'));
      await page.getByRole('radio', { name: '最早使用时间', exact: true }).click();
      assert.ok((await dates())[0].includes('2020'));
      await page.getByRole('button', { name: '改为从旧到新', exact: true }).click();
      assert.ok((await dates())[0].includes('1998'));
      assert.deepEqual(await overflow(), [], `${width}/${theme}: history overflow`);
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.weq-avatar-history-grid img')].every(
          (img) => img.complete && img.naturalWidth > 1,
        ),
      );
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-history.png`) });
      await page.locator('.weq-avatar-history-image').first().click();
      await page.waitForFunction(() => {
        const img = document.querySelector('.weq-unified-preview img');
        return img?.complete && img.naturalWidth > 1;
      });
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Escape');
      await page.locator('.weq-unified-preview').waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('button', { name: '关闭历史头像' }).count(), 1);
      await page.getByRole('button', { name: '关闭历史头像' }).click();
      results.push({
        width,
        theme,
        overflow: false,
        defaultReadOnly: true,
        sort: true,
        imageDecoded: true,
        escapeOnlyTop: true,
      });
    }
  await page.getByRole('button', { name: '历史头像', exact: true }).click();
  await page.evaluate(() => window.selfProfileQa.failHistory());
  await page.getByRole('button', { name: '重试', exact: true }).waitFor();
  assert.equal(await page.locator('.weq-avatar-history-grid article').count(), 2);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByText('共 4 个头像', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭历史头像' }).click();
  const count = await page.evaluate(() => window.selfProfileQa.requests());
  await page.waitForTimeout(1400);
  assert.equal(
    await page.evaluate(() => window.selfProfileQa.requests()),
    count,
    'closing stops pagination',
  );
  assert.deepEqual(errors, []);
  if (output)
    await writeFile(
      resolve(output, 'result.json'),
      JSON.stringify({ results, errors, failureRetry: true, writes: 'synthetic-only' }, null, 2),
    );
  console.log(JSON.stringify({ cases: results.length, failureRetry: true, errors }));
} finally {
  await browser?.close();
  await server.close();
}
