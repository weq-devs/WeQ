import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-message-profile-actions'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/relation-profile.stub.ts'),
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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const output = process.env.WEQ_MESSAGE_PROFILE_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [390, 1180])
    for (const dark of [false, true])
      for (const popover of [false, true]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/test/browser/message-profile-actions.html?${dark ? 'dark&' : ''}${popover ? 'popover' : ''}`,
        );
        const profile = page.getByRole(popover ? 'dialog' : 'region', {
          name: '群资料',
          exact: true,
        });
        await profile.getByRole('button', { name: '查看消息', exact: true }).waitFor();
        await profile.getByRole('button', { name: '预览消息', exact: true }).click();
        await profile.getByRole('button', { name: '返回资料', exact: true }).waitFor();
        assert.equal(await profile.locator('[aria-label="合成群详情"]').count(), 0);
        const bounds = await profile.boundingBox();
        assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1);
        const preview = await profile.locator('.weq-contact-chat-preview').boundingBox();
        assert(preview && preview.height > 100 && preview.y + preview.height <= 845);
        if (output)
          await page.screenshot({
            path: resolve(
              output,
              `${width}-${dark ? 'dark' : 'light'}-${popover ? 'popover' : 'embedded'}.png`,
            ),
          });
        await profile.getByRole('button', { name: '返回资料', exact: true }).click();
        assert.equal(await profile.locator('.weq-contact-chat-preview').count(), 0);
        await profile.getByRole('button', { name: '查看消息', exact: true }).click();
        await page.getByText('已查看群消息', { exact: true }).waitFor();
        cases++;
      }
  assert.deepEqual(errors, []);
  console.log(`PASS ${cases} message profile action cases`);
} finally {
  await browser?.close();
  await server.close();
}
