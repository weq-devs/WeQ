import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const image = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#e46187' } })
  .png()
  .toBuffer();
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  cacheDir: resolve(root, 'node_modules/.vite-favorite-picker'),
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/favorite-picker.stub.ts'),
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
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).pathname.startsWith('/_media/cemoji'))
      return route.fulfill({
        contentType: 'image/png',
        body: image,
      });
    return new URL(route.request().url()).hostname === '127.0.0.1'
      ? route.continue()
      : route.abort();
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/favorite-picker.html`,
  );
  await page.getByRole('button', { name: '收藏', exact: true }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.emoji-cell img')].length === 3 &&
      [...document.querySelectorAll('.emoji-cell img')].every((img) => img.naturalWidth === 64),
  );
  if (output) await mkdir(output, { recursive: true });
  for (const [dark, width, accent, background] of [
    [false, 1100, '#075c30', 'plain'],
    [true, 1100, '#fff3a1', 'paper'],
    [false, 360, '#a82e68', 'grid'],
    [true, 360, '#73cab8', 'telegram'],
  ]) {
    await page.setViewportSize({ width, height: 780 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(
      ([dark, accent, background]) => window.favoritePickerTheme(dark, accent, background),
      [dark, accent, background],
    );
    await page.getByRole('button', { name: '周三快乐', exact: true }).click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem').count(), 4);
    const menu = await page.getByRole('menu').boundingBox();
    assert(
      menu &&
        menu.x >= 0 &&
        menu.y >= 0 &&
        menu.x + menu.width <= width &&
        menu.y + menu.height <= 780,
    );
    if (output)
      await page.screenshot({
        path: resolve(output, `favorite-menu-${dark ? 'dark' : 'light'}-${width}.png`),
      });
    await page.getByRole('menuitem', { name: '备注', exact: true }).click();
    await page.getByRole('textbox', { name: '表情备注', exact: true }).fill('');
    if (output)
      await page.screenshot({
        path: resolve(output, `favorite-remark-${dark ? 'dark' : 'light'}-${width}.png`),
      });
    await page.getByRole('button', { name: '取消修改表情备注' }).click();
    assert(await page.getByRole('toolbar', { name: '收藏表情导入导出' }).isVisible());
    const overflow = await page
      .getByRole('toolbar', { name: '收藏表情导入导出' })
      .evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    assert.equal(overflow, false, '收藏工具栏溢出');
  }
  await page.getByRole('button', { name: '周三快乐', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移到最前' }).click();
  assert.equal(
    await page.locator('[aria-haspopup="menu"]').first().getAttribute('title'),
    '周三快乐',
  );
  await page.getByRole('button', { name: '周三快乐', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '备注', exact: true }).click();
  await page.getByRole('textbox', { name: '表情备注', exact: true }).fill('新的备注');
  await page.getByRole('button', { name: '保存表情备注' }).click();
  await page.getByRole('button', { name: '新的备注', exact: true }).waitFor();
  await page.getByRole('button', { name: '微笑', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert(await page.getByRole('button', { name: '微笑', exact: true }).isVisible());
  await page.getByRole('button', { name: '微笑', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await page.getByRole('button', { name: '微笑', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '新的备注', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '保存', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入图片到收藏表情' }).click();
  await (await chooser).setFiles({
    name: 'import.png',
    mimeType: 'image/png',
    buffer: image,
  });
  await page.getByRole('button', { name: '导入的图片', exact: true }).waitFor();
  const calls = await page.evaluate(() => window.favoritePickerCalls);
  assert(
    calls.some((call) => call.path === 'account.qqActions.favorite' && call.input.action === 'add'),
  );
  assert(
    calls.some(
      (call) => call.path === 'account.mediaSave.save' && call.input.source.url.includes('v=ori'),
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    '收藏选择器：四组主题/背景/宽度、菜单及备注浮层、排序、原图保存与图片导入通过（合成数据）',
  );
} finally {
  await browser?.close();
  await server.close();
}
