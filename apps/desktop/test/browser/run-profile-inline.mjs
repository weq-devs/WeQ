import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stub = resolve(root, 'test/browser/contact-card.stub.ts');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_INLINE_QA;
const server = await createServer({
  configFile: false,
  root,
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
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  if (output) await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-inline.html`;
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page.goto(url);
  await button('编辑备注').waitFor();
  assert.equal(
    (await page.evaluate(() => window.contactCardQa.calls)).some((call) =>
      call.path.includes('qqWrite'),
    ),
    false,
  );
  await button('编辑备注').click();
  await page.getByRole('textbox', { name: '备注', exact: true }).fill('取消的备注');
  await button('取消编辑备注').click();
  assert.equal(
    (await page.evaluate(() => window.contactCardQa.calls)).some((call) =>
      call.path.endsWith('friendRemark'),
    ),
    false,
  );
  await button('编辑备注').click();
  await page.getByRole('textbox', { name: '备注', exact: true }).fill('新的好友备注');
  await button('保存备注').click();
  assert.equal(await button('编辑备注').textContent(), '新的好友备注');
  await button('编辑好友分组').click();
  await page.getByRole('combobox', { name: '好友分组' }).selectOption('2');
  await button('保存好友分组').click();
  assert.equal(await button('编辑好友分组').textContent(), '同学');
  await button('编辑备注').click();
  await page.getByRole('textbox', { name: '备注', exact: true }).fill('');
  await button('保存备注').click();
  assert.equal(await button('编辑备注').textContent(), '添加备注');
  await button('编辑备注').click();
  await page.getByRole('textbox', { name: '备注', exact: true }).fill('保存失败也保留输入');
  await page.evaluate(() => {
    window.contactCardQa.failWrite = true;
  });
  await button('保存备注').click();
  assert.equal(
    await page.getByRole('textbox', { name: '备注', exact: true }).inputValue(),
    '保存失败也保留输入',
  );
  for (const width of [1280, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#47bc97' : '#c64556',
        );
      }, theme);
      const form = page.locator('.weq-member-inline-field');
      const geometry = await form.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return [...node.querySelectorAll('input,button')].map((control) => {
          const rect = control.getBoundingClientRect();
          return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right + 1;
        });
      });
      assert.ok(geometry.every(Boolean));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (output) await page.screenshot({ path: resolve(output, `remark-${width}-${theme}.png`) });
    }
  await button('取消编辑备注').click();
  await page.goto(`${url}?group=1`);
  await button('编辑群名称').click();
  await page.getByRole('textbox', { name: '群名称' }).fill('新群名称');
  await button('保存群名称').click();
  assert.equal(await button('编辑群名称').textContent(), '新群名称');
  await button('编辑备注').click();
  await page.getByRole('textbox', { name: '备注', exact: true }).fill('新的群备注');
  await button('保存备注').click();
  assert.equal(await button('编辑备注').textContent(), '新的群备注');
  await button('编辑备注').click();
  if (output) await page.screenshot({ path: resolve(output, 'group-dark-320.png') });
  await button('取消编辑备注').click();
  await page.evaluate(() => {
    const qa = window.contactCardQa;
    qa.role = 'member';
    qa.notify();
  });
  assert.equal(await button('编辑群名称').count(), 0);
  await page.evaluate(() => {
    const qa = window.contactCardQa;
    qa.inGroup = false;
    qa.notify();
  });
  assert.equal(await button('编辑备注').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'lazy-read',
        'cancel',
        'save-and-clear',
        'category-select',
        'failed-draft',
        'six-theme-layouts',
        'group-fields',
        'group-roles',
      ],
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
