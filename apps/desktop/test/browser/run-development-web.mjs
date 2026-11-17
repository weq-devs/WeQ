import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { developmentWeb } from '../../../../scripts/dev-web.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, webkit } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const { WebCore } = await tsImport('../../src/main/web/application.ts', import.meta.url);
const { router } = await tsImport('../../src/main/ipc/trpc.ts', import.meta.url);
const { RemotePairing, tokenHash } = await tsImport(
  '../../src/main/remote/pairing.ts',
  import.meta.url,
);
const { RemoteWebGateway } = await tsImport(
  '../../src/main/remote/web_gateway.ts',
  import.meta.url,
);
const { createRemoteServer } = await tsImport('../../src/main/remote/http.ts', import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'weq-browser-hmr-')));
let browser;
let remote;
const desktop = createServer();
const pairing = new RemotePairing();
try {
  const web = join(root, 'apps/web');
  await mkdir(web, { recursive: true });
  await symlink(
    join(desktopRoot, 'node_modules'),
    join(web, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(web, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(web, 'vite.config.ts'),
    `
    import config from ${JSON.stringify(join(desktopRoot, '../web/vite.config.ts'))};
    export default { ...config, root: ${JSON.stringify(web)}, cacheDir: ${JSON.stringify(join(root, 'vite-cache'))},
      optimizeDeps: { entries: [${JSON.stringify(join(web, 'index.html'))}] },
      server: { fs: { allow: [${JSON.stringify(root)}, ${JSON.stringify(resolve(desktopRoot, '../..'))}] } } };
  `,
  );
  await writeFile(
    join(web, 'index.html'),
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>`,
  );
  await writeFile(
    join(web, 'entry.tsx'),
    `import {createRoot} from 'react-dom/client'; import App from './App'; await window.startupGate; createRoot(document.getElementById('root')!).render(<App/>);`,
  );
  await writeFile(join(web, 'style.css'), 'body { color: rgb(20, 40, 60); }');
  const app = (version) =>
    `import {useState} from 'react'; import './style.css'; export default function App() { const [count,setCount]=useState(0); return <main><h1>${version}</h1><input aria-label="draft" defaultValue=""/><button onClick={()=>setCount(count+1)}>{count}</button></main>; }`;
  await writeFile(join(web, 'App.tsx'), app('version one'));
  desktop.listen(0, '127.0.0.1');
  await once(desktop, 'listening');
  await developmentWeb(root).configureServer({ httpServer: desktop });
  const core = new WebCore({
    publicDir: join(root, 'missing-static'),
    exportDir: join(root, 'exports'),
    version: 'test',
    router: router({}),
    developmentUrl: process.env.WEQ_DEV_WEB_URL,
  });
  const token = 'a'.repeat(64);
  const claim = pairing.claim({
    invitation: pairing.invite().secret,
    name: 'browser fixture',
    tokenHash: tokenHash(token),
    scope: 'web:access',
  });
  pairing.decide(claim.id, true);
  remote = createRemoteServer(pairing, new RemoteWebGateway(pairing, (auth) => core.entry(auth)));
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  const base = `http://127.0.0.1:${remote.address().port}`;
  const engine = process.env.WEQ_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
  browser = await engine.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  for (const width of [390, 1180]) {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      userAgent: 'Mozilla/5.0 WeQRemote',
    });
    await context.addCookies([{ name: 'weq_remote', value: token, url: base }]);
    await context.addInitScript(
      (platform) => {
        window.legacyStartupReports = [];
        window.startupGate = new Promise((resolve) => {
          window.releaseStartup = resolve;
        });
        const receive = (state) => {
          if (Object.values(state).some((value) => typeof value !== 'string'))
            throw new Error('旧壳仅接受字符串阶段字段');
          window.legacyStartupReports.push({ ...state });
        };
        if (platform === 'ios') {
          window.webkit = { messageHandlers: { weqStartup: { postMessage: receive } } };
          window.addEventListener('weq-remote-startup', () =>
            window.webkit.messageHandlers.weqStartup.postMessage(window.weqRemoteStartup),
          );
        } else {
          window.weqRemoteLinks = {
            startup: (state, message) => receive({ state, message: message || '' }),
          };
          window.addEventListener('weq-remote-startup', () =>
            window.weqRemoteLinks.startup(
              window.weqRemoteStartup.state,
              window.weqRemoteStartup.message,
            ),
          );
        }
      },
      width === 390 ? 'ios' : 'android',
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await writeFile(join(web, 'App.tsx'), app('version one'));
    const deadline = Date.now() + 5000;
    while (
      !(await (await fetch(`${process.env.WEQ_DEV_WEB_URL}/App.tsx`)).text()).includes(
        'version one',
      )
    ) {
      if (Date.now() > deadline) throw new Error('Vite 未应用测试初始源码');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await page.goto(base, { waitUntil: 'commit' });
    try {
      await page.waitForFunction(
        () =>
          window.legacyStartupReports.some((state) =>
            /已加载 [\d.]+ [KM]B，\d+ 项/.test(state.message || ''),
          ),
        undefined,
        { timeout: 20_000 },
      );
    } catch (error) {
      console.error({
        width,
        errors,
        progress: await page.evaluate(() => ({
          injected: Boolean(document.querySelector('[data-weq-development-progress]')),
          state: window.weqRemoteStartup,
          reports: window.legacyStartupReports,
          resources: performance.getEntriesByType('resource').map((entry) => ({
            path: new URL(entry.name).pathname,
            status: entry.responseStatus,
            decoded: entry.decodedBodySize,
            encoded: entry.encodedBodySize,
          })),
        })),
      });
      throw error;
    }
    assert.equal(await page.getByRole('heading', { name: 'version one' }).count(), 0);
    assert.equal(
      await page.evaluate(() =>
        window.legacyStartupReports.some((state) => state.message?.includes('%')),
      ),
      false,
    );
    await page.evaluate(() => window.releaseStartup());
    try {
      await page.getByRole('heading', { name: 'version one' }).waitFor({ timeout: 10_000 });
    } catch (error) {
      console.error({ width, errors, body: await page.locator('body').innerText() });
      throw error;
    }
    await page.evaluate(() => {
      window.weqRemoteStartup = { state: 'ready' };
      window.dispatchEvent(new Event('weq-remote-startup'));
    });
    const progressCount = await page.evaluate(() => window.legacyStartupReports.length);
    await page.getByRole('button').click();
    await page.getByRole('textbox').fill('keep this draft');
    await page.evaluate(() => {
      window.hmrPageIdentity = 'retained';
    });
    await writeFile(join(web, 'App.tsx'), app('version two'));
    await page.getByRole('heading', { name: 'version two' }).waitFor();
    assert.equal(await page.getByRole('button').textContent(), '1');
    assert.equal(await page.getByRole('textbox').inputValue(), 'keep this draft');
    assert.equal(await page.evaluate(() => window.hmrPageIdentity), 'retained');
    await writeFile(join(web, 'style.css'), 'body { color: rgb(80, 60, 40); }');
    await page.waitForFunction(() => getComputedStyle(document.body).color === 'rgb(80, 60, 40)');
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => window.legacyStartupReports.length), progressCount);
    console.log(
      `PASS ${width}px: legacy startup byte/item progress before entry, no fabricated total, Remote auth, React/CSS HMR, counter/draft/document retained`,
    );
    if (width === 390) {
      await writeFile(join(web, 'App.tsx'), 'export default function App(');
      await page.locator('vite-error-overlay').waitFor({ state: 'attached' });
      assert.equal(await page.getByRole('heading', { name: 'version two' }).count(), 1);
      assert.equal(await page.getByRole('textbox').inputValue(), 'keep this draft');
      await writeFile(join(web, 'App.tsx'), app('version repaired'));
      await page.getByRole('heading', { name: 'version repaired' }).waitFor();
      await page.locator('vite-error-overlay').waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('button').textContent(), '1');
      assert.equal(await page.getByRole('textbox').inputValue(), 'keep this draft');
      console.log(
        'PASS syntax error: last rendered page retained, repaired source recovers without reload',
      );
    }
    await context.close();
  }
} finally {
  await browser?.close();
  remote?.closeAllConnections();
  if (remote) await new Promise((resolve) => remote.close(resolve));
  pairing.clear();
  if (desktop.listening) await new Promise((resolve) => desktop.close(resolve));
  await rm(root, { recursive: true, force: true });
}
