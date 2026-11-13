import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const output = process.env.WEQ_ESCAPE_QA;
const stubId = '/__escape_stub.ts';
const fixtureId = '/__escape_fixture.tsx';
const stub = `
const data = {
  'account.dbExplorer.listDatabases': [{name: 'fixture.db', path: '/fixture/db', bytes: 1}],
  'account.dbExplorer.listObjects': [],
};
const noop = () => {};
function proxy(path = '') {
  return new Proxy(noop, {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      if (key === 'useQuery') return () => ({data: data[path], isLoading: false, isFetching: false});
      if (key === 'useMutation') return () => ({mutate: noop, mutateAsync: async () => undefined, isLoading: false});
      if (key === 'useSubscription') return noop;
      if (key === 'useUtils') return () => proxy();
      if (['query', 'mutate', 'fetch', 'invalidate'].includes(key)) return async () => data[path] ?? [];
      return proxy(path ? path + '.' + String(key) : String(key));
    },
  });
}
export const trpc = proxy(), client = proxy();
export const useSelfFace = () => ({nick: '合成账号', initial: '合'});
`;
const fixture = `
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BlobDialog} from '/src/renderer/src/views/cache/CacheShared';
import {DbExplorer} from '/src/renderer/src/views/cache/DbExplorer';
import {QzoneShareLightbox} from '/src/renderer/src/views/annual-report/QzoneShareLightbox';
import {ReportViewContext} from '/src/renderer/src/views/annual-report/reportContext';
import {OcrTextPanel} from '/src/renderer/src/components/OcrTextPanel';
import {MediaPreviewShell} from '/src/renderer/src/components/MediaPreviewShell';
import {DatabaseDamagedDialog} from '/src/renderer/src/components/DatabaseDamagedDialog';
import {ArkPanel} from '/src/renderer/src/im-template/template/arkPanel';
import {ConfirmDialog} from '/src/renderer/src/im-template/template/chatPane';
import '/src/renderer/src/styles/index.css';
import '/src/renderer/src/styles/cache.css';
import '/src/renderer/src/styles/annual-report.css';
import '/src/renderer/src/styles/lightbox-actions.css';
import '/src/renderer/src/im-template/styles.css';
import logo from '@resources/brand/logo.png';
function unexpected() { throw Error('Esc 不应发送、发表或删除'); }
function Fixture() {
  const [kind, setKind] = useState('');
  const [ocr, setOcr] = useState(true);
  const close = () => setKind('');
  window.escapeQa = {show: (next) => {setOcr(true); setKind(next);}};
  return <main style={{padding: 24}}>
    <button id="trigger">打开合成弹窗</button>
    {kind === 'blob' && <BlobDialog title="合成表情" meta="本地资源" onClose={close}>
      <img src={logo} width="160" height="160" alt="合成预览" />
    </BlobDialog>}
    {kind === 'confirm' && <ConfirmDialog title="确定删除本地聊天记录？" onCancel={close} onConfirm={unexpected} />}
    {kind === 'share' && <ReportViewContext.Provider value={{overlayHostRef: {current: null}}}><QzoneShareLightbox year={2026}
      slides={[{page: {id: 'fixture', title: '合成报告', category: '合成', description: '合成预览'}, data: {}}]}
      getHtml={async () => unexpected()} onClose={close} /></ReportViewContext.Provider>}
    {kind === 'ocr' && <MediaPreviewShell title="合成图片" onClose={close}>
      <img src={logo} width="160" height="160" alt="合成预览" />
      {ocr && <OcrTextPanel blocks={[{text: '合成识别文字', parag: 0, rect: {x: 0, y: 0, width: 100, height: 20}}]}
        onExit={() => setOcr(false)} />}
    </MediaPreviewShell>}
    {kind === 'database' && <DbExplorer />}
    {kind === 'feedback' && <DatabaseDamagedDialog
      event={{reason: 'database-damaged', kind: 'check-error', uin: 'fixture', title: '合成提醒', message: '', details: [], failures: [], reportPath: null}}
      onClose={close} onOpenSettings={() => {}} onOpenRepair={() => {}} />}
    {kind === 'ark' && <div style={{position: 'fixed', left: 12, bottom: 20, zIndex: 1200}}>
      <ArkPanel disabled={false} disabledHint="" contacts={{friends: [{id: '123', name: '合成好友'}], groups: [{id: '456', name: '合成群'}]}}
        onSend={async () => unexpected()} onClose={close} />
    </div>}
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-escape-qa'),
  optimizeDeps: {
    entries: [],
    noDiscovery: true,
    include: [
      'react',
      'react-dom/client',
      'react/jsx-runtime',
      'lucide-react',
      'react-icons/ai',
      '@tanstack/react-query',
      '@tanstack/react-virtual',
      '@trpc/react-query',
      '@xmldom/xmldom',
      'clsx',
      'd3',
      'linkify-it',
      'lottie-web/build/player/lottie_light',
      'shiki/core',
      'shiki/engine/javascript',
      'shiki/langs',
      'shiki/themes/github-dark.mjs',
      'shiki/themes/github-light.mjs',
      'superjson',
      'tailwind-merge',
      'zod',
      'zustand',
    ],
  },
  plugins: [
    react(),
    tailwind(),
    {
      name: 'escape-fixture',
      resolveId(id) {
        if (id === fixtureId || id === stubId) return id;
      },
      load(id) {
        if (id === fixtureId) return fixture;
        if (id === stubId) return stub;
      },
      configureServer(server) {
        server.middlewares.use('/escape.html', (_req, res, next) => {
          res.setHeader('Content-Type', 'text/html');
          void server
            .transformIndexHtml(
              '/escape.html',
              `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="${fixtureId}"></script></body></html>`,
            )
            .then((html) => res.end(html))
            .catch(next);
        });
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stubId },
      { find: './useSelfFace', replacement: stubId },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  server: {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: [resolve(root, '../..')] },
  },
});
let browser;
let page;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  page = await browser.newPage({
    viewport: { width: 1180, height: 850 },
    reducedMotion: 'reduce',
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) =>
    errors.push(`${request.url()}: ${request.failure()?.errorText}`),
  );
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/escape.html`);
  await page.locator('#trigger').waitFor({ timeout: 10000 });
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const width of [1180, 390])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'light' ? '#167d67' : '#db7aa4',
        );
      }, theme);
      for (const kind of ['blob', 'confirm', 'share', 'ocr', 'database', 'feedback', 'ark']) {
        await page.evaluate(() => window.escapeQa.show(''));
        await page.locator('#trigger').focus();
        await page.evaluate((kind) => window.escapeQa.show(kind), kind);
        const selector = {
          blob: '.weq-blob-dialog',
          confirm: '.confirm-dialog',
          share: '.weq-qzshare-card',
          ocr: '.weq-ocr-panel',
          database: '.weq-cache-db',
          feedback: '.weq-db-damaged',
          ark: '.ark-panel',
        }[kind];
        await page.locator(selector).waitFor();
        if (kind === 'share') await page.locator('.weq-qzshare-text').fill('合成测试文案');
        if (kind === 'database') await page.locator('.weq-cache-dbpick-btn').click();
        if (kind === 'feedback')
          await page.getByRole('button', { name: '反馈问题', exact: true }).click();
        if (kind === 'ark') {
          await page.locator('.ark-contact input').focus();
          await page.locator('.ark-contact-list').waitFor();
        }
        await page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => {})),
          ),
        );
        if (
          output &&
          ((width === 1180 && theme === 'light') || (width === 390 && theme === 'dark'))
        )
          await page.screenshot({ path: resolve(output, `${kind}-${theme}-${width}.png`) });
        await page.keyboard.press('Escape');
        if (['blob', 'confirm', 'share'].includes(kind)) {
          await page.locator(selector).waitFor({ state: 'detached' });
          assert.equal(await page.evaluate(() => document.activeElement?.id), 'trigger');
        }
        if (kind === 'ocr') {
          await page.locator('.weq-ocr-panel').waitFor({ state: 'detached' });
          assert.equal(await page.locator('.weq-lightbox-layer').count(), 1);
          await page.keyboard.press('Escape');
          await page.locator('.weq-lightbox-layer').waitFor({ state: 'detached' });
        }
        if (kind === 'database') {
          await page.locator('.weq-cache-dbpick-menu').waitFor({ state: 'detached' });
          assert.equal(await page.locator('.weq-cache-db').count(), 1);
        }
        if (kind === 'feedback' || kind === 'ark') {
          await page
            .locator(kind === 'feedback' ? '.weq-db-feedback-menu' : '.ark-contact-list')
            .waitFor({ state: 'detached' });
          assert.equal(await page.locator(selector).count(), 1);
          await page.keyboard.press('Escape');
          await page.locator(selector).waitFor({ state: 'detached' });
        }
        cases++;
      }
    }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases, errors, screenshots: output }, null, 2));
} catch (error) {
  if (output && page) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: resolve(output, 'failure.png') });
  }
  console.error(JSON.stringify({ errors, body: await page?.locator('body').innerHTML() }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
