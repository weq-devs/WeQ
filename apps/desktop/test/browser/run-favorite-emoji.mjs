import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/favorite-emoji.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
  const image = await sharp({
    create: { width: 100, height: 100, channels: 3, background: '#289664' },
  })
    .png()
    .toBuffer();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/_media/') || url.pathname.startsWith('/_asset/'))
      return route.fulfill({ contentType: 'image/png', body: image });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/favorite-emoji.html`;
  const open = async (id, index = 0) => {
    try {
      await page
        .locator(`[data-message-id="${id}"] [data-favorite-emoji-source]`)
        .nth(index)
        .click({ button: 'right' });
    } catch (error) {
      console.error(await page.locator('body').innerText());
      if (process.env.WEQ_STYLE_ARTIFACTS)
        await page.screenshot({ path: resolve(process.env.WEQ_STYLE_ARTIFACTS, 'failure.png') });
      throw error;
    }
    await page.getByRole('button', { name: '添加到表情', exact: true }).waitFor();
  };
  await page.goto(base);
  const output = process.env.WEQ_STYLE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [theme, width, accent, background] of [
    ['light', 1280, '#176c47', 'plain'],
    ['dark', 1280, '#f3e7a1', 'grid'],
    ['light', 390, '#ffffff', 'paper'],
    ['system', 390, '#000000', 'dots'],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.evaluate((args) => window.favoriteFixture(...args), [theme, accent, background]);
    await open('custom');
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-message-id="custom"] img.qq-media-mface');
      return image?.naturalWidth > 0 && getComputedStyle(image).opacity === '1';
    });
    const add = page.getByRole('button', { name: '添加到表情', exact: true });
    if (!(await add.isEnabled())) throw new Error('在线入口没有启用');
    if (
      await page.getByRole('menu').evaluate((menu) => {
        const rect = menu.getBoundingClientRect();
        return (
          rect.left < 0 ||
          rect.top < 0 ||
          rect.right > innerWidth ||
          rect.bottom > innerHeight ||
          menu.scrollWidth > menu.clientWidth
        );
      })
    )
      throw new Error(`${theme}/${width}: 菜单溢出`);
    if (output) await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
    await add.click();
    await page.waitForFunction(() =>
      document.querySelector('.message-context-menu button[aria-busy="true"]'),
    );
    await page.getByRole('menu').waitFor({ state: 'detached' });
    await page.getByText('已添加到表情', { exact: true }).first().waitFor();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await open('multiple', 1);
  await page.getByRole('button', { name: '添加到表情', exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'detached' });
  if (!(await page.evaluate(() => window.favoriteRequests.at(-1).url)).includes('second.gif'))
    throw new Error('多图没有选择第二张');
  await open('market');
  await page.getByRole('button', { name: '添加到表情', exact: true }).click();
  await page.getByRole('menu').waitFor({ state: 'detached' });
  if (!(await page.evaluate(() => window.favoriteRequests.at(-1).url)).includes('mface'))
    throw new Error('商城表情目标错误');
  await page.locator('[data-message-id="system"] .message-bubble').click({ button: 'right' });
  if (await page.getByRole('button', { name: '添加到表情', exact: true }).count())
    throw new Error('系统表情出现错误入口');
  await page.goto(`${base}?offline=1`);
  await open('custom');
  if (!(await page.getByRole('button', { name: '添加到表情', exact: true }).isDisabled()))
    throw new Error('离线未禁用');
  await page.goto(`${base}?fail=1`);
  await open('custom');
  await page.getByRole('button', { name: '添加到表情', exact: true }).click();
  await page.getByText('合成取图失败，请稍后重试', { exact: true }).waitFor();
  if (!(await page.getByRole('button', { name: '添加到表情', exact: true }).isEnabled()))
    throw new Error('失败后不能重试');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    '添加到表情浏览器验证通过：4 组主题／背景／尺寸，动图与商城入口、多图目标、提交读回、离线禁用和失败重试。',
  );
} finally {
  await browser?.close();
  await server.close();
}
