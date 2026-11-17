import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engines = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: 'ts',
    contents: `
    import { preloadMobilePages } from './src/renderer/src/lib/mobilePageLoading';
    import { scheduleBackgroundLoad } from './src/renderer/src/lib/backgroundLoad';
    const calls = [];
    let release;
    const stops = [];
    window.weqRemoteStartup = {state:'loading'};
    const field = document.querySelector('input');
    document.querySelector('button').onclick = () => {
      calls.push({kind:'open', at:performance.now()});
      document.querySelector('output').textContent = 'opened';
    };
    window.remoteLoadingQa = {
      calls,
      queue() {
        stops.push(preloadMobilePages([async () => {calls.push({kind:'first',at:performance.now()}); await new Promise(resolve => {release=resolve})}]));
        stops.push(preloadMobilePages([async () => {calls.push({kind:'second',at:performance.now()})}]));
      },
      ready() {window.weqRemoteStartup={state:'ready'}; window.dispatchEvent(new Event('weq-remote-startup'))},
      read() {stops.push(scheduleBackgroundLoad(() => calls.push({kind:'read',at:performance.now()}),0))},
      release() {release()},
      cancel() {for(const stop of stops)stop()},
    };
  `,
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
});
const script = bundle.outputFiles[0].text;
const server = createServer((request, response) => {
  response.setHeader(
    'Content-Type',
    request.url === '/fixture.js' ? 'text/javascript' : 'text/html',
  );
  response.end(
    request.url === '/fixture.js'
      ? script
      : '<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui}input,button{font:inherit;margin:12px}main{height:250px;overflow:auto}li{height:48px}</style><input aria-label="message"><button>Open</button><output></output><main><ul>' +
          '<li>Conversation</li>'.repeat(100) +
          '</ul></main><script src="/fixture.js"></script>',
  );
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
try {
  for (const [name, executablePath] of [
    ['chromium', process.env.WEQ_CHROMIUM_EXECUTABLE ?? process.env.WEQ_BROWSER_EXECUTABLE],
    ['webkit', process.env.WEQ_WEBKIT_EXECUTABLE],
  ]) {
    const browser = await engines[name].launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    try {
      for (const width of [390, 1180]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.evaluate(() => window.remoteLoadingQa.queue());
        await page.waitForTimeout(300);
        assert.deepEqual(await page.evaluate(() => window.remoteLoadingQa.calls), []);
        await page.locator('input').focus();
        await page.evaluate(() => {
          window.remoteLoadingQa.ready();
          document.querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.keyboard.type('typing while modules are waiting', { delay: 25 });
        assert.deepEqual(
          await page.evaluate(() => window.remoteLoadingQa.calls),
          [],
          '持续输入期间不能派发模块预热',
        );
        await page.locator('main').hover();
        for (let turn = 0; turn < 5; turn++) {
          await page.mouse.wheel(0, 120);
          await page.waitForTimeout(50);
          assert.deepEqual(
            await page.evaluate(() => window.remoteLoadingQa.calls),
            [],
            '持续滚动期间不能派发模块预热',
          );
        }
        await page.waitForFunction(() =>
          window.remoteLoadingQa.calls.some((item) => item.kind === 'first'),
        );
        await page.evaluate(() => window.remoteLoadingQa.read());
        await page.waitForFunction(() =>
          window.remoteLoadingQa.calls.some((item) => item.kind === 'read'),
        );
        assert.equal(
          await page.evaluate(() =>
            window.remoteLoadingQa.calls.some((item) => item.kind === 'second'),
          ),
          false,
          '不同预热入口不能并发执行',
        );
        const start = performance.now();
        await page.getByRole('button', { name: 'Open' }).click();
        assert.equal(
          await page.locator('output').textContent(),
          'opened',
          '用户打开不能排在慢预热后面',
        );
        const clickMs = performance.now() - start;
        assert.equal(await page.locator('input').inputValue(), 'typing while modules are waiting');
        await page.evaluate(() => window.remoteLoadingQa.release());
        await page.waitForFunction(() =>
          window.remoteLoadingQa.calls.some((item) => item.kind === 'second'),
        );
        await page.evaluate(() => window.remoteLoadingQa.cancel());
        assert.deepEqual(errors, []);
        console.log(
          JSON.stringify({
            browser: name,
            width,
            gatedUntilReady: true,
            typingYield: true,
            slowPreloadDoesNotBlockReadOrOpen: true,
            clickMs,
          }),
        );
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
