import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_ASSISTANT_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-assistant-resume'),
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/assistant-resume.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  optimizeDeps: { entries: ['test/browser/assistant-resume.html'] },
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
  const errors = [];
  if (output) await mkdir(output, { recursive: true });
  for (const width of [1280, 390, 320])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width < 600,
        hasTouch: width < 600,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
      );
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/assistant-resume.html`,
      );
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.background = theme === 'light' ? 'grid' : 'telegram';
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#075c30' : '#fff3a1',
        );
      }, theme);
      const stop = page.getByRole('button', { name: '停止输出', exact: true });
      await stop.waitFor();
      assert.equal(await page.locator('.composer .weq-asst-run-button').count(), 0);
      assert.equal(await page.locator('.weq-asst-content').filter({ has: stop }).count(), 1);
      const box = await stop.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 900);
      assert(box.width >= (width < 600 ? 44 : 32));
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-running.png`) });
      await stop.click();
      const resume = page.getByRole('button', { name: '恢复输出', exact: true });
      await resume.waitFor();
      assert.match(await page.locator('.weq-asst-content').innerText(), /已整理出第一部分/);
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}-stopped.png`) });
      await resume.click();
      await stop.waitFor();
      await page.evaluate(() => window.assistantFixture.append('继续补充第二部分。'));
      await page.waitForFunction(() =>
        document.querySelector('.weq-asst-content')?.textContent?.includes('继续补充第二部分。'),
      );
      assert.match(await page.locator('.weq-asst-content').innerText(), /已整理出第一部分/);
      assert.equal(await page.locator('.weq-asst-content .weq-asst-md p').count(), 2);
      await stop.click();
      await resume.waitFor();
      assert.match(await page.locator('.weq-asst-content').innerText(), /继续补充第二部分/);
      await resume.click();
      await stop.waitFor();
      await page.evaluate(() => window.assistantFixture.finish());
      await stop.waitFor({ state: 'detached' });
      assert.equal(await resume.count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await context.close();
    }
  assert.deepEqual(errors, []);
  console.log(
    '助手停止与恢复：3 种宽度 × 2 种主题通过，原消息保留、继续流式输出与再次停止均正常。',
  );
} finally {
  await browser?.close();
  await server.close();
}
