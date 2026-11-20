import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_DRESS_ARTIFACTS ?? resolve(root, '.artifacts/dress-usage');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-dress-usage'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/dress-usage.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  optimizeDeps: { entries: ['test/browser/dress-usage.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
const bubble = await sharp({
  create: { width: 40, height: 40, channels: 4, background: '#c5e8ca' },
})
  .png()
  .toBuffer();
const font = await readFile(resolve(root, '../../resources/assistant/fonts/cover.otf'));
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/_media/dressfont')
      return route.fulfill({ contentType: 'font/otf', body: font });
    if (url.pathname.startsWith('/_media/'))
      return route.fulfill({ contentType: 'image/png', body: bubble });
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/dress-usage.html`;
  for (const width of [1200, 768, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`${url}?theme=${theme}&tools=1`);
      await page.getByRole('heading', { name: '使用中的装扮' }).waitFor();
      assert.equal(
        await page.getByRole('tab', { name: '使用中', exact: true }).getAttribute('aria-selected'),
        'true',
      );
      assert.equal(await page.locator('.weq-dress-current').count(), 6);
      const bubbleScope = page.getByRole('combobox', { name: '聊天气泡渲染范围' });
      await bubbleScope.click();
      await page.getByRole('option', { name: '替代无装扮', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="聊天气泡渲染范围"]').dataset.value === 'fallback',
      );
      assert.equal(
        await page.getByRole('combobox', { name: '聊天字体渲染范围' }).getAttribute('data-value'),
        'mine',
      );
      await page.locator('.weq-dress-applying').waitFor({ state: 'detached' });
      await bubbleScope.focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.querySelector('[aria-label="聊天气泡渲染范围"]').dataset.value === 'all',
      );
      await page.locator('.weq-dress-applying').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.weq-dress-search').count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      const overflow = await page
        .locator('.weq-dress-usage')
        .evaluate((root) =>
          [...root.querySelectorAll('button, label, strong, small')]
            .filter((node) => node.scrollWidth > node.clientWidth + 2)
            .map((node) => node.textContent),
        );
      assert.deepEqual(overflow, [], '文本与操作不得溢出');
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '取消使用聊天气泡', exact: true }).click();
      await page
        .getByRole('button', { name: '取消使用聊天气泡', exact: true })
        .waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '选择聊天气泡', exact: true }).click();
      await page.getByRole('tab', { name: '聊天气泡', exact: true }).waitFor();
      assert.equal(await page.getByRole('combobox', { name: '聊天气泡渲染范围' }).count(), 0);
      assert.equal(await page.locator('.weq-dress-local-note').count(), 0);
      await page.getByRole('button', { name: '使用', exact: true }).click();
      await page.getByRole('button', { name: '使用中', exact: true }).waitFor();
      await page.getByRole('tab', { name: '使用中', exact: true }).click();
      await page.getByRole('button', { name: '取消使用聊天气泡', exact: true }).waitFor();
    }
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.goto(`${url}?tools=1&exceptions=1&backdrop=1`);
  const background = page.getByRole('article', { name: '聊天背景' });
  await background.getByRole('slider', { name: '聊天背景不透明度' }).waitFor();
  await background.getByText('1 个会话单独设置').click();
  await background.getByRole('button', { name: /项目讨论.*不使用/ }).click();
  const mode = page.getByRole('radiogroup', { name: '本会话聊天背景' });
  await mode.waitFor();
  assert.equal(
    await mode.getByRole('radio', { name: '不使用' }).getAttribute('aria-checked'),
    'true',
  );
  await page.screenshot({ path: resolve(output, 'conversation-override.png'), fullPage: true });
  await mode.getByRole('radio', { name: '跟随全局' }).click();
  await background.getByText('1 个会话单独设置').waitFor({ state: 'detached' });

  await page.goto(`${url}?empty=1&tools=1`);
  await page.getByRole('heading', { name: '使用中的装扮' }).waitFor();
  assert.equal(await page.getByText('未使用', { exact: true }).count(), 6);
  assert.equal(await page.getByText('按消息记录还原', { exact: true }).count(), 3);
  await page.screenshot({ path: resolve(output, 'empty.png'), fullPage: true });

  // 原始 ID 保留，但 data-bubble 尚未挂上：模拟已有装扮的加载中和失败状态。
  for (const scope of ['mine', 'fallback', 'all']) {
    const result = await page.evaluate(
      ({ scope, image }) => {
        const { applyDressSkin } = window.dressUsageQa;
        applyDressSkin(
          {
            itemId: 77,
            slice: { left: 4, right: 4, top: 4, bottom: 4 },
            imageSize: { w: 40, h: 40 },
            textColor: '#173c28',
            baseImage: image,
          },
          null,
          null,
          scope,
        );
        const host = document.createElement('main');
        host.innerHTML = ['mine', 'theirs']
          .flatMap((side) =>
            [false, true].map(
              (original) =>
                `<div class="message-line ${side}" ${original ? 'data-record-bubble="99"' : ''}><div class="message-content">测试文字</div></div>`,
            ),
          )
          .join('');
        document.body.append(host);
        const selected = [...host.querySelectorAll('.message-content')].map(
          (node) =>
            getComputedStyle(node).borderImageSource !== 'none' ||
            getComputedStyle(node, '::before').borderImageSource !== 'none',
        );
        host.remove();
        applyDressSkin(null, null, null);
        return selected;
      },
      { scope, image: `data:image/png;base64,${bubble.toString('base64')}` },
    );
    assert.deepEqual(
      result,
      scope === 'mine'
        ? [true, true, false, false]
        : scope === 'fallback'
          ? [true, false, true, false]
          : [true, true, true, true],
    );
  }
  for (const width of [1200, 390, 320])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.goto(`${url}?theme=${theme}`);
      await page.getByRole('tab', { name: '聊天背景', exact: true }).waitFor();
      assert.equal(await page.getByRole('tab').count(), 1);
      assert.equal(
        await page.locator('.weq-dress-use, .weq-dress-save, .weq-dress-search').count(),
        0,
      );
      assert.equal(
        await page.getByRole('button', { name: '选择聊天气泡', exact: true }).count(),
        0,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: resolve(output, `normal-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: 开发工具 8 组深浅色/宽窄屏、三档切换、键盘选择、会话例外定位与恢复跟随、取消/使用、原始装扮 CSS；普通模式 6 组仅保留背景',
  );
} finally {
  await browser?.close();
  await server.close();
}
