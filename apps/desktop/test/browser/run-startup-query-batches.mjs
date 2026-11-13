import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  optimizeDeps: { entries: ['test/browser/startup-query-batches.html'] },
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
  const url = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/startup-query-batches.html`;
  const results = [];
  for (const width of [390, 1180]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(url);
    await page.waitForFunction(() => window.startupBatchQa?.loaded);
    assert.equal(await page.evaluate(() => window.startupBatchQa.requests.length), 0);
    await page.evaluate(() => window.startupBatchQa.firstPage());
    await page.waitForFunction(() => window.startupBatchQa.requests.length === 1);
    const first = await page.evaluate(() => window.startupBatchQa.requests[0]);
    await page.waitForFunction(
      () => performance.getEntriesByName('first-contentful-paint').length > 0,
    );
    const firstPaint = await page.evaluate(
      () => performance.getEntriesByName('first-contentful-paint')[0].startTime,
    );
    assert(
      firstPaint > 0 && firstPaint <= first.at,
      `首批后台请求必须晚于首屏实际绘制：${JSON.stringify({ firstPaint, batchStart: first.at })}`,
    );
    assert(await page.locator('#first-page').isVisible());
    await page.evaluate(() => {
      window.startupBatchQa.busy(true);
      window.startupBatchQa.complete(1);
    });
    await page.waitForTimeout(200);
    assert.equal(
      await page.evaluate(() => window.startupBatchQa.requests.length),
      1,
      '前台忙时不启动下一批',
    );
    await page.evaluate(() => window.startupBatchQa.busy(false));
    await page.waitForFunction(() => window.startupBatchQa.requests.length === 2);
    for (let stage = 2; stage < 5; stage++) {
      await page.evaluate((stage) => window.startupBatchQa.complete(stage), stage);
      await page.waitForFunction(
        (count) => window.startupBatchQa.requests.length === count,
        stage + 1,
      );
    }
    await page.evaluate(() => window.startupBatchQa.complete(5));
    await page.waitForTimeout(100);
    const requests = await page.evaluate(() => window.startupBatchQa.requests);
    assert.deepEqual(
      requests.map((r) => r.stage),
      [1, 2, 3, 4, 5],
    );
    if (process.env.WEQ_STARTUP_ARTIFACTS) {
      await mkdir(process.env.WEQ_STARTUP_ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: resolve(process.env.WEQ_STARTUP_ARTIFACTS, `startup-batches-${width}.png`),
      });
    }
    results.push({ width, firstPaint, requests });
    await page.goto(url);
    await page.waitForFunction(() => window.startupBatchQa?.loaded);
    await page.evaluate(() => window.startupBatchQa.firstPage());
    await page.waitForFunction(() => window.startupBatchQa.requests.length === 1);
    await page.evaluate(() => {
      window.startupBatchQa.busy(true);
      window.startupBatchQa.complete(1);
      window.startupBatchQa.cancel();
      window.startupBatchQa.busy(false);
    });
    await page.waitForTimeout(250);
    assert.equal(
      await page.evaluate(() => window.startupBatchQa.requests.length),
      1,
      '账号切换后旧批次不继续',
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      { results, firstPaintVerified: true, busyYieldVerified: true, cancellationVerified: true },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
