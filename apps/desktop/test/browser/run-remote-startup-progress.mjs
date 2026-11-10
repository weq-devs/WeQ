import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { serveStatic } from '../../src/main/web/static.ts';

const client = process.env.WEQ_REMOTE_CLIENT_REPO;
if (!client) throw new Error('需要 WEQ_REMOTE_CLIENT_REPO 指向手机仓库');
const script = await readFile(join(client, 'resources/web-startup-progress.js'), 'utf8');
const { webkit, chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const root = await mkdtemp(resolve('.artifacts/remote-startup-progress-'));
await mkdir(join(root, 'assets'));
await writeFile(
  join(root, 'index.html'),
  '<!doctype html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'"><link rel="stylesheet" href="/assets/style-12345678.css"><link rel="modulepreload" href="/assets/shared-12345678.js"><script type="module" src="/assets/main-12345678.js"></script></head><body><main>合成启动页面</main></body>',
);
await writeFile(
  join(root, 'assets/style-12345678.css'),
  'body{background:white;color:black}'.repeat(100),
);
await writeFile(join(root, 'assets/shared-12345678.js'), 'export const shared=1;');
await writeFile(
  join(root, 'assets/main-12345678.js'),
  'import {shared} from "./shared-12345678.js";window.weqRemoteStartup={state:"loading",message:"正在检查恢复状态"};window.dispatchEvent(new Event("weq-remote-startup"));setTimeout(()=>{window.weqRemoteStartup={state:"ready"};window.dispatchEvent(new Event("weq-remote-startup"));window.__ready=shared},400);',
);
let requests = 0;
const server = createServer((req, res) => {
  if (req.url?.startsWith('/assets/')) requests++;
  const delay = req.url?.includes('main-') ? 1600 : req.url?.includes('shared-') ? 700 : 0;
  setTimeout(() => {
    void serveStatic(res, root, req.url ?? '/', req.headers['accept-encoding'], true).catch((e) => {
      res.destroy(e);
    });
  }, delay);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
try {
  for (const [name, engine, executable] of [
    ['webkit', webkit, process.env.WEQ_WEBKIT_EXECUTABLE],
    ['chromium', chromium, process.env.WEQ_CHROMIUM_EXECUTABLE],
  ]) {
    const browser = await engine.launch({
      headless: true,
      ...(executable ? { executablePath: executable } : {}),
    });
    try {
      for (const timing of ['early', 'late']) {
        const context = await browser.newContext({
          userAgent: 'WeQRemote',
          viewport: { width: 390, height: 844 },
        });
        await context.addInitScript({
          content:
            'window.__downloadProgress=[];window.webkit={messageHandlers:{weqResources:{postMessage:v=>window.__downloadProgress.push(v)}}};' +
            (timing === 'early' ? script : ''),
        });
        const page = await context.newPage();
        for (let load = 0; load < 2; load++) {
          await page.goto(url, { waitUntil: 'commit' });
          if (timing === 'late') {
            await page.waitForTimeout(200);
            await page.evaluate(script);
          }
          await page.waitForFunction(() => window.__ready === 1);
          const values = await page.evaluate(() => window.__downloadProgress);
          if (values.at(-1)?.completed !== 3)
            console.log(
              await page.evaluate(() =>
                performance.getEntriesByType('resource').map((e) => ({
                  name: e.name,
                  responseStatus: e.responseStatus,
                  encoded: e.encodedBodySize,
                  decoded: e.decodedBodySize,
                  transfer: e.transferSize,
                  end: e.responseEnd,
                  duration: e.duration,
                })),
              ),
            );
          assert.ok(values.length >= 1, `${name}: missing progress`);
          assert.equal(values.at(-1).total, 3);
          assert.equal(values.at(-1).completed, 3);
          assert.equal(values.at(-1).loadedBytes, values.at(-1).totalBytes);
          assert.ok(values.every((v) => v.totalBytes === values[0].totalBytes));
          assert.ok(values.every((v, i) => i === 0 || v.loadedBytes >= values[i - 1].loadedBytes));
          if (!load)
            assert.ok(
              values.some((v) => v.completed > 0 && v.completed < v.total),
              `${name}: no intermediate download state`,
            );
          console.log(
            JSON.stringify({
              engine: name,
              timing,
              load,
              updates: values.length,
              totalBytes: values[0].totalBytes,
              final: values.at(-1).completed,
            }),
          );
        }
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
  assert.equal(requests, 12, '重载应命中浏览器资源缓存，不重复下载代码');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
