import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/composer-whitespace-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir,
  define: { 'import.meta.env.VITE_WEQ_TARGET': '"web"' },
  optimizeDeps: { entries: ['test/browser/timeline.html'] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(here, 'trpc.stub.ts') },
      {
        find: /^@weq\/agentlab$/,
        replacement: resolve(root, '../../packages/agentlab/src/model_selection.ts'),
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

const results = [];
const output = process.env.WEQ_COMPOSER_ARTIFACTS;
let browser;
try {
  await server.listen();
  if (output) await mkdir(output, { recursive: true });
  for (const engine of ['chromium', 'webkit']) {
    browser = await engines[engine].launch({ headless: true });
    for (const width of [390, 1280]) {
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          reducedMotion: 'reduce',
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) =>
          new URL(route.request().url()).hostname === '127.0.0.1'
            ? route.continue()
            : route.abort(),
        );
        try {
          await page.goto(
            `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?mobile-input&composer-actions&count=30`,
          );
          const editor = page.locator('.composer > .composer-editor');
          const send = page.locator('.composer .composer-send');
          await editor.waitFor();
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.dataset.background = theme === 'light' ? 'paper' : 'dots';
            document.documentElement.style.setProperty(
              '--weq-accent-effective',
              theme === 'light' ? '#15764a' : '#ebbd51',
            );
          }, theme);
          const bodies = () => page.evaluate(() => window.timelineTest.sentBodies());
          const serialize = () =>
            editor.evaluate(async (node) => {
              const { serializeComposer } = await import(
                '/src/renderer/src/im-template/template/composer.tsx'
              );
              return serializeComposer(node);
            });
          const submit = async () => {
            if (width > 760) await send.click();
            else await editor.press('Enter');
          };

          assert(await send.isDisabled());
          await editor.press('Enter');
          assert.deepEqual(await bodies(), []);
          for (const body of [' ', '\n', '\n\n', ' \t\n ', '\n 正文 \n']) {
            await editor.fill(body);
            assert.equal(
              await serialize(),
              body,
              JSON.stringify({ engine, width, body, html: await editor.innerHTML() }),
            );
            assert(await send.isEnabled());
            await submit();
            assert.equal((await bodies()).at(-1), body);
          }
          await editor.press('Space');
          assert.equal(await serialize(), ' ');
          await editor.press('Enter');
          assert.equal((await bodies()).at(-1), ' ');
          await editor.press('Shift+Enter');
          assert.equal(await serialize(), '\n');
          await editor.press('Shift+Enter');
          assert.equal(await serialize(), '\n\n');
          await editor.press('Enter');
          assert.equal((await bodies()).at(-1), '\n\n');

          for (const body of ['待删除', '\n', '\n\n']) {
            await editor.fill(body);
            await editor.press('ControlOrMeta+A');
            await editor.press('Backspace');
            assert.equal(await serialize(), '', `删除后仍有正文: ${await editor.innerHTML()}`);
            assert(await send.isDisabled());
            const count = (await bodies()).length;
            await editor.press('Enter');
            assert.equal((await bodies()).length, count);
          }

          for (const body of ['', ' \n']) {
            await editor.fill(body);
            await page.locator('.message-bubble').last().click({ button: 'right' });
            await page.locator('.message-context-menu button[aria-label="引用"]').click();
            assert.equal(await serialize(), body, '引用操作改变了输入框正文');
            await submit();
            const elements = await page.evaluate(async () => {
              const { composerTextToElements } = await import(
                '/src/renderer/src/im-template/template/draftElements.ts'
              );
              return composerTextToElements(window.timelineTest.sentBodies().at(-1));
            });
            assert.equal(elements.length, 2);
            assert(elements.some((element) => element.kind === 'reply'));
            assert.deepEqual(
              elements.filter((element) => element.kind === 'text'),
              [{ kind: 'text', textContent: body || ' ' }],
            );
          }
          if (width <= 760) {
            await editor.fill('多行正文\n'.repeat(10));
            await page.locator('.mobile-composer-expand-button').click();
            const expanded = page.locator('.mobile-composer-expanded-editor');
            await expanded.fill(' \n\n');
            await page.locator('.composer-send-expanded').click();
            assert.equal((await bodies()).at(-1), ' \n\n');
          }
          await editor.fill(' \n');
          if (output)
            await page.screenshot({ path: resolve(output, `${engine}-${width}-${theme}.png`) });
          assert.deepEqual(errors, []);
          results.push({ engine, width, theme, sent: (await bodies()).length });
        } finally {
          await page.close();
        }
      }
    }
    await browser.close();
    browser = null;
  }
  console.log(JSON.stringify({ results }));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
