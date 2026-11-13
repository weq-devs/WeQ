import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_STYLE_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwind()],
  cacheDir: resolve(root, 'node_modules/.vite-empty-states'),
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
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/empty-states.html`,
  );
  await page.locator('[data-fixture="panel"] .weq-empty-state').waitFor();
  if (output) await mkdir(output, { recursive: true });
  for (const [theme, width, accent, background] of [
    ['light', 1280, '#176c47', 'plain'],
    ['dark', 1280, '#f3e7a1', 'grid'],
    ['light', 360, '#ffffff', 'paper'],
    ['dark', 360, '#73cab8', 'dots'],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(
      ({ theme, accent, background }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.background = background;
        document.documentElement.style.setProperty('--weq-accent-effective', accent);
      },
      { theme, accent, background },
    );
    const geometry = await page.locator('.weq-empty-state').evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        const icon = element.querySelector('.weq-empty-state-icon').getBoundingClientRect();
        return {
          variant: element.className,
          height: bounds.height,
          overflow: element.scrollWidth > element.clientWidth + 1,
          left: bounds.left,
          right: bounds.right,
          icon: icon.width,
        };
      }),
    );
    assert.equal(geometry.length, 11);
    for (const item of geometry) {
      assert.equal(item.overflow, false, `${theme}/${width} 空态文字不溢出`);
      assert.ok(item.left >= 0 && item.right <= width, '空态不超出视口');
      assert.equal(
        item.icon,
        item.variant.includes('is-inline') ? 22 : item.variant.includes('is-compact') ? 30 : 40,
      );
    }
    assert.ok(
      geometry.find((item) => item.variant.includes('is-inline')).height < 100,
      '分组空态保持轻量',
    );
    for (const element of await page.locator('.weq-empty-state-icon').all())
      assert.equal(await element.getAttribute('aria-hidden'), 'true');
    if (output)
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), fullPage: true });
  }
  await page.locator('[data-fixture="scope"] button').click();
  await page.getByRole('button', { name: '已恢复', exact: true }).waitFor();
  const conversations = page.locator('[data-fixture="conversations"]');
  await conversations.locator('input').fill('合成查询');
  await conversations.getByText('没有匹配的会话', { exact: true }).waitFor();
  const single = page.locator('[data-fixture="single"]');
  await single.locator('input').fill('合成查询');
  await single.getByText('没有匹配项', { exact: true }).waitFor();
  assert.equal(
    await single.getByText('合成说明文字', { exact: true }).count(),
    0,
    '筛选无结果不显示未筛选说明',
  );
  assert.deepEqual(errors, []);
  console.log(
    '空状态浏览器回归通过：11 个真实组件及样式场景，4 组主题、主题色、背景与桌面/360px 窄屏，操作、搜索切换、长文案和三档密度。',
  );
} finally {
  await browser?.close();
  await server.close();
}
