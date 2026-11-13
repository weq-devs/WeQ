import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localizeArtifact } from '../../../../packages/service/src/account/export/offline_artifact.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(join(root, 'node_modules/.cache'), { recursive: true });
const temp = await mkdtemp(join(root, 'node_modules/.cache/offline-artifact-'));
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
let browser, server;
try {
  const source = join(temp, 'source');
  await mkdir(source);
  const entry = join(source, 'index.html');
  await writeFile(
    entry,
    '<!doctype html><meta charset="utf-8"><title>离线成果</title><link rel="stylesheet" integrity="sha256-old" href="https://assets.invalid/main.css"><h1>离线成果</h1><img id="image" alt="测试图片" src="https://assets.invalid/image.png"><p id="status">未加载</p><script type="module" integrity="sha256-old" src="https://assets.invalid/main.js"></script>',
  );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const files = new Map([
    [
      'https://assets.invalid/main.css',
      '@import "theme.css"; img{width:80px;height:80px;image-rendering:pixelated}',
    ],
    [
      'https://assets.invalid/theme.css',
      'body{font-family:sans-serif;padding:32px;color:rgb(10,90,50)}',
    ],
    [
      'https://assets.invalid/main.js',
      'import { value } from "./cycle.js"; document.querySelector("#status").textContent=value;',
    ],
    ['https://assets.invalid/cycle.js', 'import "./main.js"; export const value="静态依赖已加载";'],
    ['https://assets.invalid/image.png', png],
  ]);
  const result = await localizeArtifact({
    entry,
    sourcePath: entry,
    outputEntry: join(temp, 'output/index.html'),
    cacheDirectory: join(temp, 'cache'),
    signal: new AbortController().signal,
    download: async (url, path) => {
      const data = files.get(url);
      if (!data) return { ok: false, reason: 'missing' };
      await writeFile(path, data);
      return {
        ok: true,
        bytes: Buffer.byteLength(data),
        contentType: url.endsWith('.css')
          ? 'text/css'
          : url.endsWith('.js')
            ? 'text/javascript'
            : 'image/png',
        finalUrl: url,
        sha256: '',
      };
    },
  });
  assert.equal(result.complete, true);
  const moved = join(temp, 'moved');
  await rename(join(temp, 'output'), moved);
  await rm(source, { recursive: true });
  await rm(join(temp, 'cache'), { recursive: true });
  const failed = [];
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
  };
  server = createServer(async (request, response) => {
    const path = resolve(moved, `.${new URL(request.url, 'http://localhost').pathname}`);
    try {
      assert.ok(path.startsWith(`${moved}/`));
      const data = await readFile(path);
      response.writeHead(200, {
        'content-type': mime[extname(path)] ?? 'application/octet-stream',
      });
      response.end(data);
    } catch {
      failed.push(request.url);
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  const errors = [],
    external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.getByText('静态依赖已加载', { exact: true }).waitFor();
  assert.equal(
    await page.locator('#image').evaluate((image) => image.complete && image.naturalWidth > 0),
    true,
  );
  assert.equal(
    await page.locator('body').evaluate((body) => getComputedStyle(body).color),
    'rgb(10, 90, 50)',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(failed, []);
  if (process.env.WEQ_REQUIREMENTS_QA)
    await page.screenshot({ path: join(process.env.WEQ_REQUIREMENTS_QA, 'offline-relocated.png') });
  console.log(
    JSON.stringify({
      relocated: true,
      originalAndCacheRemoved: true,
      imageRendered: true,
      cssRendered: true,
      cyclicModulesExecuted: true,
      externalRequests: external,
      pageErrors: errors,
    }),
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(temp, { recursive: true, force: true });
}
