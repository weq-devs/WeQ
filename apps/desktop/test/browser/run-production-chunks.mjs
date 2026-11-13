import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '../..');
const entry = '\0weq-production-chunk-smoke';
const result = await build({
  configFile: resolve(root, '../web/vite.config.ts'),
  logLevel: 'silent',
  resolve: { alias: { '@transport': resolve(root, 'test/support/transport.stub.ts') } },
  plugins: [
    {
      name: 'production-chunk-smoke',
      resolveId: (id) => (id === entry ? entry : null),
      load: (id) =>
        id === entry
          ? `
      import { MainView } from ${JSON.stringify(resolve(root, 'src/renderer/src/views/MainView.tsx'))};
      import { QqMarkdown } from ${JSON.stringify(resolve(root, 'src/renderer/src/components/QqMarkdownContent.tsx'))};
      import { shikiCodeHighlighter as plugin } from ${JSON.stringify(resolve(root, 'src/renderer/src/views/agentlab/shikiHighlighter.ts'))};
      globalThis.chunkSmoke = { MainView, QqMarkdown, plugin };
    `
          : null,
    },
  ],
  build: { write: false, reportCompressedSize: false, rollupOptions: { input: entry } },
});
const assets = new Map(
  result.output.map((asset) => [
    `/${asset.fileName}`,
    asset.type === 'chunk' ? asset.code : asset.source,
  ]),
);
const main = result.output.find((asset) => asset.type === 'chunk' && asset.isEntry);
assert(main?.type === 'chunk');
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<script type="module" src="/${main.fileName}"></script>`);
  } else if (assets.has(path)) {
    response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(assets.get(path));
  } else response.writeHead(404).end();
});
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page
    .waitForFunction(() => globalThis.chunkSmoke, null, { timeout: 15_000 })
    .catch(() => {
      throw new Error(errors.join('\n') || '生产分块未完成初始化');
    });
  const checks = await page.evaluate(async () => {
    const { MainView, QqMarkdown, plugin } = globalThis.chunkSmoke;
    const highlighted = await Promise.race([
      Promise.all(
        ['typescript', 'cpp', 'emacs-lisp'].map(
          (language) =>
            new Promise((resolve) => {
              const code = language === 'emacs-lisp' ? '(message "hello")' : 'const answer = 42;';
              const ready = (result) => {
                if (result?.tokens.flat().some((token) => token.htmlStyle)) resolve(language);
              };
              ready(plugin.highlight({ code, language, themes: plugin.getThemes() }, ready));
            }),
        ),
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('代码高亮加载超时')), 30_000)),
    ]);
    return { main: typeof MainView, markdown: typeof QqMarkdown, highlighted };
  });
  assert.equal(checks.main, 'function');
  assert.equal(checks.markdown, 'object');
  assert.deepEqual(checks.highlighted, ['typescript', 'cpp', 'emacs-lisp']);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', ...checks }));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
