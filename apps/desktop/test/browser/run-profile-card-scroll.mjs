import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_PROFILE_CARD_SCROLL_QA;
const results = [];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  if (output) await mkdir(output, { recursive: true });
  for (const fixture of ['contact-card', 'group-card-refactor']) {
    const stub = resolve(root, `test/browser/${fixture}.stub.ts`);
    const server = await createServer({
      configFile: false,
      root,
      plugins: [react(), tailwind()],
      define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
      resolve: {
        alias: [
          { find: /^.*\/trpc\/client$/, replacement: stub },
          ...(fixture === 'contact-card'
            ? [{ find: /^.*\/hooks\/useQQWriteSession$/, replacement: stub }]
            : []),
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
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    try {
      await server.listen();
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/test/browser/${fixture}.html`,
      );
      const card = page.locator('.weq-member-pop.weq-contact-card').first();
      await card.waitFor();
      await page.waitForTimeout(300);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 600 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          const layout = await card.evaluate((node) => {
            node.scrollLeft = 1000;
            node.scrollTop = node.scrollHeight;
            const actions = node.querySelector('.weq-profile-card-actions');
            const bounds = node.getBoundingClientRect();
            const footer = actions.getBoundingClientRect();
            return {
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
              scrollLeft: node.scrollLeft,
              scrollTop: node.scrollTop,
              footerFits: footer.left >= bounds.left && footer.right <= bounds.right,
              footerVisible: footer.top >= bounds.top && footer.bottom <= bounds.bottom,
            };
          });
          results.push({ fixture, width, theme, ...layout });
          assert.equal(layout.scrollWidth, layout.clientWidth, JSON.stringify(results.at(-1)));
          assert.equal(layout.scrollLeft, 0, '名片不应横向滚动');
          assert.ok(layout.scrollTop > 0, '长名片仍应支持纵向滚动');
          assert.ok(layout.footerFits && layout.footerVisible, '底部操作栏应完整可见');
          await card.evaluate((node) => {
            node.scrollTop = 0;
          });
          if (output)
            await page.screenshot({ path: resolve(output, `${fixture}-${width}-${theme}.png`) });
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
      await server.close();
    }
  }
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  await browser?.close();
}
