import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'vite';
import { mkdir } from 'node:fs/promises';

const root = resolve(import.meta.dirname, '../..');
const entry = '\0weq-production-chunk-smoke';
const policy = '\0weq-production-export-policy';
const result = await build({
  configFile: resolve(root, '../web/vite.config.ts'),
  logLevel: 'silent',
  resolve: {
    alias: [
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
      { find: /.*\/hooks\/useExportSavePolicy$/, replacement: policy },
    ],
  },
  plugins: [
    {
      name: 'production-chunk-smoke',
      resolveId: (id) => (id === entry || id === policy ? id : null),
      load: (id) =>
        id === policy
          ? 'export function useExportSavePolicy(){return {binding:null,serverLocation:null,settings:{isLoading:false},isCurrent:()=>true}}'
          : id === entry
            ? `
      import { MainView } from ${JSON.stringify(resolve(root, 'src/renderer/src/views/MainView.tsx'))};
      import { QqMarkdown } from ${JSON.stringify(resolve(root, 'src/renderer/src/components/QqMarkdownContent.tsx'))};
      import { shikiCodeHighlighter as plugin } from ${JSON.stringify(resolve(root, 'src/renderer/src/views/agentlab/shikiHighlighter.ts'))};
      import { createElement as h, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ForwardWindowHost, openForwardWindow } from ${JSON.stringify(resolve(root, 'src/renderer/src/components/ForwardWindow.tsx'))};
      import ${JSON.stringify(resolve(root, 'src/renderer/src/styles/index.css'))};
      function Shell() {
        const [count,setCount]=useState(0);
        return h('main',null,h('button',{'data-startup-ready':true,onClick:()=>setCount(n=>n+1)},'首屏操作 '+count),h(ForwardWindowHost));
      }
      createRoot(document.getElementById('root')).render(h(Shell));
      globalThis.chunkSmoke = { MainView, QqMarkdown, plugin, open:()=>openForwardWindow({title:'生产分包预览',kind:'c2c',conv:'',msgId:'synthetic',records:[]}) };
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
const forwardChunk = result.output.find(
  (asset) =>
    asset.type === 'chunk' &&
    Object.keys(asset.modules).some((id) => id.endsWith('/components/ForwardWindowContent.tsx')),
);
assert(forwardChunk?.type === 'chunk');
const styles = result.output
  .filter((asset) => asset.type === 'asset' && asset.fileName.endsWith('.css'))
  .map((asset) => `<link rel="stylesheet" href="/${asset.fileName}">`)
  .join('');
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<div id="root"></div><script type="module" src="/${main.fileName}"></script>`,
    );
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
  await page.close();
  const forwardChecks = [];
  if (process.env.WEQ_CHUNK_ARTIFACTS)
    await mkdir(process.env.WEQ_CHUNK_ARTIFACTS, { recursive: true });
  for (const width of [390, 1180])
    for (const theme of ['light', 'dark']) {
      const viewer = await browser.newPage({
        viewport: { width, height: 800 },
        reducedMotion: 'reduce',
      });
      const pageErrors = [];
      viewer.on('pageerror', (error) => pageErrors.push(error.message));
      await viewer.addInitScript((theme) => {
        document.addEventListener('DOMContentLoaded', () => {
          document.documentElement.dataset.theme = theme;
        });
      }, theme);
      let release = () => {};
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let requests = 0;
      await viewer.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== '127.0.0.1') return route.abort();
        if (url.pathname === `/${forwardChunk.fileName}`) {
          requests++;
          await gate;
        }
        return route.continue();
      });
      try {
        await viewer.goto(`http://127.0.0.1:${server.address().port}/`);
        await viewer.locator('[data-startup-ready]').waitFor();
        assert.equal(requests, 0, '首屏不得请求转发正文');
        await viewer.evaluate(() => globalThis.chunkSmoke.open());
        const pending = viewer.locator('.weq-forward-window[aria-busy="true"]');
        await pending.waitFor();
        const pendingBounds = await pending.boundingBox();
        assert(pendingBounds.x >= 0 && pendingBounds.x + pendingBounds.width <= width);
        await viewer.locator('[data-startup-ready]').click();
        assert.equal(await viewer.locator('[data-startup-ready]').textContent(), '首屏操作 1');
        if (process.env.WEQ_CHUNK_ARTIFACTS)
          await viewer.screenshot({
            path: resolve(process.env.WEQ_CHUNK_ARTIFACTS, `pending-${width}-${theme}.png`),
          });
        await pending.getByRole('button', { name: '关闭', exact: true }).click();
        release();
        await viewer.waitForLoadState('networkidle');
        assert.equal(
          await viewer.locator('.weq-forward-window').count(),
          0,
          '加载完成不得复活已关闭窗口',
        );
        await viewer.evaluate(() => globalThis.chunkSmoke.open());
        const loaded = viewer.locator('.weq-forward-window:not([aria-busy])');
        await loaded.waitFor().catch(() => {
          throw new Error(pageErrors.join('\n') || '转发正文未显示');
        });
        const loadedBounds = await loaded.boundingBox();
        for (const key of ['x', 'y', 'width', 'height'])
          assert(Math.abs(pendingBounds[key] - loadedBounds[key]) < 1, `正文加载后不得跳变 ${key}`);
        assert.equal(requests, 1, '正文仅加载一次');
        assert(await loaded.textContent().then((text) => text.includes('没有更多消息')));
        if (process.env.WEQ_CHUNK_ARTIFACTS)
          await viewer.screenshot({
            path: resolve(process.env.WEQ_CHUNK_ARTIFACTS, `loaded-${width}-${theme}.png`),
          });
        await loaded.getByRole('button', { name: '关闭', exact: true }).click();
        assert.deepEqual(pageErrors, []);
        forwardChecks.push({ width, theme, bodyRequests: requests });
      } finally {
        release();
        await viewer.close();
      }
    }
  console.log(JSON.stringify({ status: 'passed', ...checks, forwardChecks }));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
