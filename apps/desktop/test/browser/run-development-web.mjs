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
const { createDevelopmentReload } = await tsImport(
  '../../src/main/development_reload.ts',
  import.meta.url,
);
const root = await realpath(await mkdtemp(join(tmpdir(), 'weq-browser-hmr-')));
let activeContext;
let remote;
const desktop = createServer();
const pairing = new RemotePairing();
const bundled = process.env.WEQ_DEV_WEB_UNBUNDLED !== '1';
const dependencyRequests = new Map();
const responses = [];

async function waitForSource(text) {
  const upstream = process.env.WEQ_DEV_WEB_URL;
  const deadline = Date.now() + 15_000;
  do {
    if (bundled) {
      const html = await (await fetch(upstream)).text();
      const paths = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+\.js)"/g)];
      const files = await Promise.all(
        paths.map(async ([, path]) => (await fetch(upstream + path)).text()),
      );
      if (files.some((source) => source.includes(text))) return;
    } else if ((await (await fetch(`${upstream}/App.tsx`)).text()).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Vite 未应用测试初始源码');
}

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
      build: { ...config.build, rollupOptions: { ...config.build.rollupOptions, input: {index: ${JSON.stringify(join(web, 'index.html'))}} } },
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
  await writeFile(join(web, 'lazy.ts'), 'export const content = "lazy pane loaded";');
  const app = (version) =>
    `import {useState} from 'react'; import {SiQzone,AiOutlineRedEnvelope} from ${JSON.stringify(join(desktopRoot, 'src/renderer/src/lib/reactIcons.ts'))}; import './style.css'; export default function App() { const [count,setCount]=useState(0); const [extra,setExtra]=useState(''); return <main><h1>${version}</h1><SiQzone data-test-icon="qzone"/><AiOutlineRedEnvelope data-test-icon="red-envelope"/><input aria-label="draft" defaultValue=""/><button aria-label="count" onClick={()=>setCount(count+1)}>{count}</button><button onClick={async()=>setExtra((await import('./lazy')).content)}>load pane</button><output>{extra}</output><div aria-label="chat history" style={{height:120,overflow:'auto'}}><div style={{height:600}}>chat</div></div></main>; }`;
  await writeFile(join(web, 'App.tsx'), app('version one'));
  desktop.listen(0, '127.0.0.1');
  await once(desktop, 'listening');
  await developmentWeb(root, {
    plugins: [createDevelopmentReload().rendererPlugin()],
  }).configureServer({ httpServer: desktop });
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
  remote.on('request', (req, res) => {
    if (/\/deps\/[^/?]+\.js\?v=/.test(req.url))
      dependencyRequests.set(req.url, (dependencyRequests.get(req.url) ?? 0) + 1);
    res.once('finish', () => responses.push({ path: req.url, status: res.statusCode }));
  });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  const base = `http://127.0.0.1:${remote.address().port}`;
  const engine = process.env.WEQ_BROWSER_ENGINE === 'webkit' ? webkit : chromium;
  const launch = {
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  };
  for (const width of process.argv.includes('--mobile-only') ? [390] : [390, 1180]) {
    // Remote 使用持久网页存储；WebKit 无痕 context 的新页面不共享磁盘缓存。
    const context = await engine.launchPersistentContext(join(root, `profile-${width}`), {
      ...launch,
      viewport: { width, height: 800 },
      userAgent: 'Mozilla/5.0 WeQRemote',
    });
    activeContext = context;
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
          window.webkit = {
            messageHandlers: { weqStartup: { postMessage: receive }, weqResources: {} },
          };
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
    dependencyRequests.clear();
    responses.length = 0;
    const scripts = [];
    page.on('response', (response) => {
      if (response.headers()['content-type']?.includes('javascript')) scripts.push(response.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    if (width !== 390) {
      await writeFile(join(web, 'style.css'), 'body { color: rgb(20, 40, 60); }');
      await writeFile(join(web, 'App.tsx'), app('version one'));
    }
    await waitForSource('version one');
    await page.goto(base, { waitUntil: 'commit' });
    try {
      await page.waitForFunction(
        () => window.legacyStartupReports.some((state) => /完成 \d+ 项/.test(state.message || '')),
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
    if (width === 390)
      assert(
        await page.evaluate(() =>
          window.legacyStartupReports.some((state) =>
            /已下载 [\d.]+ [KM]B/.test(state.message || ''),
          ),
        ),
      );
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
    const code = await Promise.all(scripts);
    assert(code.length > 0);
    assert(code.every((source) => !source.includes('sourceMappingURL=data:')));
    assert(responses.every((response) => !/react-icons_(?:si|ai)\.js/.test(response.path)));
    assert.equal(await page.locator('svg[data-test-icon] path').count(), 2);
    const transfer = await page.evaluate(() => {
      const code = performance
        .getEntriesByType('resource')
        .filter((entry) => /\.(?:[cm]?js|tsx?|css)(?:\?|$)/.test(entry.name));
      return {
        requests: code.length,
        encoded: code.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
        decoded: code.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
      };
    });
    console.log(
      `COLD ${width}px ${bundled ? 'bundled' : 'unbundled'}: ${transfer.requests} code resources`,
    );
    assert(transfer.encoded > 0 && transfer.encoded < transfer.decoded / 2);
    const counter = page.getByRole('button', { name: 'count' });
    await counter.click();
    await page.getByRole('textbox').fill('keep this draft');
    await page.getByRole('button', { name: 'load pane' }).click();
    await page.getByText('lazy pane loaded').waitFor();
    const history = page.getByLabel('chat history');
    await history.evaluate((element) => {
      element.scrollTop = 100;
    });
    await page.evaluate(() => {
      window.hmrPageIdentity = 'retained';
    });
    await writeFile(join(web, 'App.tsx'), app('version two'));
    await page.getByRole('heading', { name: 'version two' }).waitFor();
    assert.equal(await counter.textContent(), '1');
    assert.equal(await page.getByRole('textbox').inputValue(), 'keep this draft');
    assert.equal(await page.evaluate(() => window.hmrPageIdentity), 'retained');
    await writeFile(join(web, 'style.css'), 'body { color: rgb(80, 60, 40); }');
    await page.waitForFunction(() => getComputedStyle(document.body).color === 'rgb(80, 60, 40)');
    assert.equal(await history.evaluate((element) => element.scrollTop), 100);
    assert.equal(await page.getByText('lazy pane loaded').count(), 1);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => window.legacyStartupReports.length), progressCount);
    console.log(
      `PASS ${width}px: startup progress, Remote auth, lazy pane, React/CSS HMR, counter/draft/scroll/document retained`,
    );
    if (width === 390) {
      await writeFile(join(web, 'App.tsx'), 'export default function App(');
      await page.locator('vite-error-overlay').waitFor({ state: 'attached' });
      assert.equal(await page.getByRole('heading', { name: 'version two' }).count(), 1);
      assert.equal(await page.getByRole('textbox').inputValue(), 'keep this draft');
      await writeFile(join(web, 'App.tsx'), app('version repaired'));
      await page.getByRole('heading', { name: 'version repaired' }).waitFor();
      await page.locator('vite-error-overlay').waitFor({ state: 'detached' });
      assert.equal(await counter.textContent(), '1');
      assert.equal(await page.getByRole('textbox').inputValue(), 'keep this draft');
      console.log(
        'PASS syntax error: last rendered page retained, repaired source recovers without reload',
      );
    }
    const before = [...dependencyRequests];
    if (!bundled) assert(before.length > 0, '真实依赖预构建应有独立网络请求');
    const reconnected = await context.newPage();
    await reconnected.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => window.releaseStartup(), { once: true });
    });
    await reconnected.goto(base, { waitUntil: 'commit' });
    await reconnected.getByRole('heading', { name: /version (?:two|repaired)/ }).waitFor();
    assert.equal(await page.evaluate(() => window.hmrPageIdentity), 'retained');
    assert.equal(await page.getByRole('textbox').inputValue(), 'keep this draft');
    assert.deepEqual([...dependencyRequests], before, '重连不应重新下载未变的版本化依赖');
    assert(responses.some((response) => response.status === 304));
    console.log(
      `PASS ${width}px reconnect: ${transfer.encoded}/${transfer.decoded} encoded/decoded bytes, no inline maps, cache revalidated, original page retained`,
    );
    await context.close();
    activeContext = undefined;
  }
} finally {
  await activeContext?.close();
  remote?.closeAllConnections();
  if (remote) await new Promise((resolve) => remote.close(resolve));
  pairing.clear();
  if (desktop.listening) await new Promise((resolve) => desktop.close(resolve));
  await rm(root, { recursive: true, force: true });
}
