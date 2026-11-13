import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'package.json'));
const { createServer } = await import(require.resolve('vite'));
const { default: react } = await import(require.resolve('@vitejs/plugin-react'));
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const entry = resolve(root, '__unread_hmr_fixture.tsx');
const mount = resolve(root, '__unread_hmr_mount.tsx');
let revision = 1;
const source = () => `
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createUnreadRefreshState} from '/src/renderer/src/lib/unreadRefresh.ts';
export default function App(){
  const state=useRef(createUnreadRefreshState());
  const [scope,setScope]=useState('account-a');
  const [count,setCount]=useState(0);
  useEffect(()=>{
    window.__runs=(window.__runs??0)+1;
    const {guard,changed}=state.current.bind(scope);
    if(changed) setCount(0);
    window.__qa={setScope,guard};
    const timer=setTimeout(()=>setCount(scope==='account-a'?10:3),700);
    return ()=>clearTimeout(timer);
  },[scope]);
  useLayoutEffect(()=>{window.__commits??=[];window.__commits.push({scope,count});});
  return <div id="count" data-scope={scope} data-revision="${revision}">{count}</div>;
}
`;
const server = await createServer({
  root,
  configFile: false,
  cacheDir: resolve(root, 'node_modules/.vite-unread-hmr'),
  optimizeDeps: {
    noDiscovery: true,
    include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'],
  },
  plugins: [
    react(),
    {
      name: 'unread-hmr-fixture',
      enforce: 'pre',
      resolveId(id) {
        if (id === '/__unread_hmr_fixture.tsx' || id === entry || id === '/@fs' + entry)
          return entry;
        if (id === '/__unread_hmr_mount.tsx' || id === mount || id === '/@fs' + mount) return mount;
      },
      load(id) {
        if (id === entry) return source();
        if (id === mount)
          return `import {createRoot} from 'react-dom/client';
          import App from '/__unread_hmr_fixture.tsx';
          createRoot(document.getElementById('root')).render(<App/>);`;
      },
      configureServer(server) {
        server.middlewares.use('/__unread_hmr.html', async (_request, response) => {
          response.setHeader('content-type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__unread_hmr.html',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/__unread_hmr_mount.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0, watch: null },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.WEQ_BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__unread_hmr.html`);
  await page.waitForFunction(() => document.getElementById('count')?.textContent === '10');
  await page.evaluate(() => {
    window.__commits.length = 0;
    window.__oldGuard = window.__qa.guard;
    window.__finish = window.__qa.guard.begin(['fixture']);
    window.__frames = [];
    window.__sampling = true;
    const sample = () => {
      if (!window.__sampling) return;
      window.__frames.push(Number(document.getElementById('count')?.textContent));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  revision++;
  server.moduleGraph.invalidateModule(server.moduleGraph.getModuleById(entry));
  server.ws.send({
    type: 'update',
    updates: [
      {
        type: 'js-update',
        path: '/__unread_hmr_fixture.tsx',
        acceptedPath: '/__unread_hmr_fixture.tsx',
        timestamp: Date.now(),
      },
    ],
  });
  await page.waitForFunction(() => window.__runs === 2);
  await page.waitForTimeout(850);
  const hmr = await page.evaluate(() => {
    window.__sampling = false;
    return {
      frames: window.__frames,
      commits: window.__commits,
      sameGuard: window.__oldGuard === window.__qa.guard,
      pendingProtected: !window.__qa.guard.accepts('fixture', window.__qa.guard.revision()),
    };
  });
  assert(hmr.frames.length > 2);
  assert(
    hmr.frames.every((count) => count === 10),
    JSON.stringify(hmr),
  );
  assert(hmr.commits.every((row) => row.count === 10));
  assert(hmr.sameGuard && hmr.pendingProtected);
  await page.evaluate(() => {
    window.__finish();
    window.__qa.setScope('account-b');
  });
  await page.waitForFunction(
    () =>
      document.getElementById('count')?.dataset.scope === 'account-b' &&
      document.getElementById('count')?.textContent === '0',
  );
  assert.equal(await page.evaluate(() => window.__oldGuard === window.__qa.guard), false);
  await page.waitForFunction(() => document.getElementById('count')?.textContent === '3');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        hmrPaintedFrames: hmr.frames.length,
        hmrCounts: [...new Set(hmr.frames)],
        sameGuard: hmr.sameGuard,
        pendingProtected: hmr.pendingProtected,
        accountSwitchCounts: [0, 3],
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
