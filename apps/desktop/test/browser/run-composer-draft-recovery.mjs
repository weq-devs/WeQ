import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const draftEditUrl = `/@fs${resolve(root, '../../packages/service/src/account/draft_edit.ts')}`;
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const cacheDir = await mkdtemp(resolve(root, 'node_modules/.cache/composer-draft-recovery-'));
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
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/timeline.html?composer-actions&count=5`;
  const results = [];
  for (const [keys, expected] of [
    [['a', 'Backspace'], ''],
    [['Shift+Enter'], ''],
    [['a', 'Shift+Enter', 'Backspace'], 'a\n'],
    [['a', 'Shift+Enter', 'b'], 'a\nb'],
  ]) {
    await page.goto(url);
    const editor = page.locator('.composer > .composer-editor');
    await editor.waitFor();
    await editor.focus();
    for (const key of keys) await editor.press(key);
    const before = await page.evaluate(async (draftEditUrl) => {
      const { serializeComposer } = await import(
        '/src/renderer/src/im-template/template/composer.tsx'
      );
      const { createComposerDraftRecovery } = await import(
        '/src/renderer/src/lib/composerDraftRecovery.ts'
      );
      const { setLocalDraft, localDraftToWrite } = await import(draftEditUrl);
      const node = document.querySelector('.composer > .composer-editor');
      const raw = serializeComposer(node);
      createComposerDraftRecovery().write('fixture', 'peer', raw);
      return {
        raw,
        html: node.innerHTML,
        pending: localDraftToWrite(setLocalDraft({}, 'peer', raw), 'peer'),
      };
    }, draftEditUrl);
    assert.equal(before.pending, expected);
    await page.reload();
    const after = await page.evaluate(async () => {
      const { createComposerDraftRecovery } = await import(
        '/src/renderer/src/lib/composerDraftRecovery.ts'
      );
      const { composerTextToElements } = await import(
        '/src/renderer/src/im-template/template/draftElements.ts'
      );
      const store = createComposerDraftRecovery();
      const recovered = store.load('fixture').peer;
      const elements = composerTextToElements(recovered);
      store.confirm('fixture', 'peer', recovered);
      return { recovered, elements, confirmed: store.load('fixture') };
    });
    assert.equal(after.recovered, expected);
    assert.deepEqual(after.elements, expected ? [{ kind: 'text', textContent: expected }] : []);
    assert.deepEqual(after.confirmed, {});
    results.push({ keys, ...before, ...after });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results }));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
