import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-ai-model-settings'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/ai-model-settings.stub.ts'),
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_SETTINGS_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/ai-model-settings.html`,
      );
      await page.getByText('高级设置', { exact: true }).waitFor();
      await page.evaluate((theme) => {
        const store = window.aiSettingsTheme.getState();
        store.setPreference(theme);
        store.setAccent(theme === 'light' ? '#075c30' : '#fff3a1');
        store.setBackground(theme === 'light' ? 'grid' : 'telegram');
      }, theme);
      for (const title of ['意图感知', '互动画像', '推荐回复']) {
        await page.locator('nav').getByRole('button', { name: title, exact: true }).click();
        const details = page.locator('details.weq-model-advanced');
        assert.equal(await details.getAttribute('open'), null);
        assert.equal(await details.locator('.weq-ai-settings-advanced').isVisible(), false);
        const mode = page.getByRole('radiogroup', { name: `${title}模式`, exact: true });
        assert.deepEqual(await mode.getByRole('radio').allTextContents(), ['自动', '手动']);
        assert.equal(
          await mode.getByRole('radio', { name: '自动', exact: true }).getAttribute('aria-checked'),
          'true',
        );
        const model = page.getByLabel(`${title} API 模型`, { exact: true });
        assert.equal(await model.inputValue(), 'default');
        assert.equal(await model.locator('option[value=""]').count(), 0);
        assert.equal(
          await model.locator('option:checked').textContent(),
          '默认（当前：gpt-fixture-long-model-name）',
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        if (output)
          await page.screenshot({
            path: resolve(output, `${title}-${theme}-${width}.png`),
            fullPage: true,
          });
        await details.locator('summary').click();
        assert.equal(await details.locator('.weq-ai-settings-advanced').isVisible(), true);
        await page
          .locator('nav')
          .getByRole('button', {
            name: title === '推荐回复' ? '意图感知' : '推荐回复',
            exact: true,
          })
          .click();
        await page.locator('nav').getByRole('button', { name: title, exact: true }).click();
        assert.equal(await details.getAttribute('open'), null);
        cases++;
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors }));
} finally {
  await browser?.close();
  await server.close();
}
