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
  'account.getAccountConfig': {uin: '10001', configId: 'fixture'},
  'account.getGroupDetail': null,
  'account.getGroupExtendedProfile': null,
  'account.getGroupAlbumAccessState': {
    qqOnline: true, attachEnabled: true, hasA2: true, hasD2: true, hasD2Key: true,
    hasGuid: true, ssoReady: true,
    source: {expectedAccountUin: '10001', expectedAccountConfigId: 'fixture'},
  },
  'account.qqWrite.commonRelationships': {
    friendCount: 1, groups: [{groupCode: '10003', name: '合成共同群'}],
  },
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
      if (['query', 'mutate', 'fetch', 'invalidate'].includes(key)) return async () => path in data ? data[path] : [];
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
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {BlobDialog} from '/src/renderer/src/views/cache/CacheShared';
import {DbExplorer} from '/src/renderer/src/views/cache/DbExplorer';
import {QzoneShareLightbox} from '/src/renderer/src/views/annual-report/QzoneShareLightbox';
import {ReportViewContext} from '/src/renderer/src/views/annual-report/reportContext';
import {OcrTextPanel} from '/src/renderer/src/components/OcrTextPanel';
import {MediaPreviewShell} from '/src/renderer/src/components/MediaPreviewShell';
import {DatabaseDamagedDialog} from '/src/renderer/src/components/DatabaseDamagedDialog';
import {ArkPanel} from '/src/renderer/src/im-template/template/arkPanel';
import {ConfirmDialog} from '/src/renderer/src/im-template/template/chatPane';
import {Modal} from '/src/renderer/src/components/Dialog';
import {ForwardWindowHost} from '/src/renderer/src/components/ForwardWindow';
import {openForwardWindow} from '/src/renderer/src/state/forwardWindow';
import {OverlayLayer} from '/src/renderer/src/components/OverlayLayer';
import {GroupFeatureSurface} from '/src/renderer/src/components/GroupFeatureSurface';
import {CommonRelationships} from '/src/renderer/src/components/qq-actions/CommonRelationships';
import {useViewState} from '/src/renderer/src/state/view';
import '/src/renderer/src/styles/index.css';
import '/src/renderer/src/styles/cache.css';
import '/src/renderer/src/styles/annual-report.css';
import '/src/renderer/src/styles/lightbox-actions.css';
import '/src/renderer/src/im-template/styles.css';
import logo from '@resources/brand/logo.png';
useViewState.setState({openedUin: '10001'});
function unexpected() { throw Error('Esc 不应发送、发表或删除'); }
const forwardActions = {
  binding: null, sendAvailable: false, forward: unexpected, merge: unexpected, addMaterial: unexpected,
};
function NestedFixture({kind, onClose}) {
  const [child, setChild] = useState(true);
  const content = <>
    <button data-parent onClick={() => setChild(true)}>父窗操作</button>
    {child && (kind === 'floating' || kind === 'popover'
      ? <Modal presentation={kind} dismissOnOutside={false} onClose={() => setChild(false)}><button data-child>子窗操作</button></Modal>
      : <OverlayLayer presentation="popover" dismissOnOutside={kind === 'group'} onClose={() => setChild(false)}><button data-child>子窗操作</button></OverlayLayer>)}
  </>;
  return kind === 'group'
    ? <GroupFeatureSurface presentation="popover" title="合成群功能" onClose={onClose}>{content}</GroupFeatureSurface>
    : <Modal presentation="floating" title="合成父窗" onClose={onClose}>{content}</Modal>;
}
function Fixture() {
  const [kind, setKind] = useState('');
  const [ocr, setOcr] = useState(true);
  const close = () => setKind('');
  window.escapeQa = {show: (next) => {
    setOcr(true);
    setKind(next);
    if (next === 'forward') {
      openForwardWindow({
        title: '合成聊天记录', kind: 'c2c', conv: '', msgId: 'fixture',
        records: [{msgId: '1', sendNick: '合成用户', elements: [{type: 'text', data: {textContent: '合成正文'}}]}],
      });
    }
  }};
  return <main style={{padding: 24}}>
    <button id="trigger">打开合成弹窗</button>
    <button id="background">背景控件</button>
    {kind === 'forward' && <ForwardWindowHost actions={forwardActions} />}
    {kind.startsWith('nested-') && <NestedFixture kind={kind.slice(7)} onClose={close} />}
    {kind === 'common' && <OverlayLayer presentation="popover" onClose={close}>
      <section role="dialog" aria-label="联系人资料"><CommonRelationships uin="10002" /></section>
    </OverlayLayer>}
    {kind.startsWith('surface-') && <Modal presentation={kind.slice(8)} onClose={close}>
      <header><h3>合成弹窗</h3></header><button>弹窗内容</button>
    </Modal>}
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
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}><Fixture /></QueryClientProvider>);
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
  await page.evaluate(() => window.escapeQa.show('forward'));
  const forward = page.getByRole('dialog', { name: '合成聊天记录' });
  await forward.getByText('合成正文', { exact: true }).waitFor();
  await page.locator('#background').click();
  await page.keyboard.press('Escape');
  assert.equal(await forward.count(), 1);
  // 点击可开始框选的正文空白区，覆盖会阻止浏览器默认聚焦的指针路径。
  await forward.locator('.weq-forward-body').click({ position: { x: 25, y: 200 } });
  await page.keyboard.press('Escape');
  await forward.waitFor({ state: 'detached' });
  cases++;
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
      for (const focus of ['inside', 'blank', 'outside', 'nested']) {
        await page.evaluate(() => window.escapeQa.show(''));
        await page.locator('#trigger').focus();
        await page.evaluate(() => window.escapeQa.show('common'));
        const trigger = page.getByRole('button', { name: '查看共同群列表', exact: true });
        await trigger.click();
        const common = page.locator('.weq-common-groups-dialog');
        await common.waitFor();
        const group = common.getByRole('button', { name: '查看 合成共同群 的群名片' });
        if (focus === 'nested') {
          await group.click();
          await page.getByRole('dialog', { name: '群资料', exact: true }).waitFor();
        }
        if (focus === 'inside') await group.focus();
        if (focus === 'outside') await trigger.focus();
        if (focus === 'blank' || focus === 'nested')
          await page.evaluate(() => document.activeElement?.blur());
        if (output && focus === 'nested')
          await page.screenshot({ path: resolve(output, `common-${theme}-${width}.png`) });
        await page.keyboard.press('Escape');
        if (focus === 'nested') {
          await page
            .getByRole('dialog', { name: '群资料', exact: true })
            .waitFor({ state: 'detached' });
          assert.equal(await common.count(), 1);
          assert.equal(await group.evaluate((node) => node === document.activeElement), true);
          await page.keyboard.press('Escape');
        }
        await common.waitFor({ state: 'detached' });
        assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
        assert.equal(await page.getByRole('dialog', { name: '联系人资料' }).count(), 1);
        await page.keyboard.press('Escape');
        await page.getByRole('dialog', { name: '联系人资料' }).waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'trigger');
        cases++;
      }
      for (const presentation of ['panel', 'popover', 'floating', 'anchored']) {
        await page.locator('#trigger').focus();
        await page.evaluate((kind) => window.escapeQa.show(kind), `surface-${presentation}`);
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await page.locator('#background').focus();
        await page.keyboard.press('Escape');
        assert.equal(await dialog.count(), 1);
        await page.locator('#trigger').focus();
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        await page.evaluate((kind) => window.escapeQa.show(kind), `surface-${presentation}`);
        await dialog.waitFor();
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'trigger');
        cases++;
      }
      for (const kind of ['popover', 'floating', 'overlay', 'group']) {
        await page.locator('#trigger').focus();
        await page.evaluate((kind) => window.escapeQa.show(kind), `nested-${kind}`);
        const child = page.locator('[data-child]');
        const parent = page.locator('[data-parent]');
        await child.waitFor();
        assert.equal(await child.evaluate((node) => node === document.activeElement), true);
        const assertOrder = async () =>
          assert.equal(
            await page.evaluate(() => {
              const layer = (selector) =>
                Number(
                  document
                    .querySelector(selector)
                    .closest('.weq-window-layer, .weq-dialog-layer, .weq-overlay-layer').style
                    .zIndex,
                );
              return layer('[data-child]') > layer('[data-parent]');
            }),
            true,
          );
        await assertOrder();
        if (kind !== 'group') {
          await parent.focus();
          await parent.dispatchEvent('pointerdown');
          await assertOrder();
          await child.focus();
        }
        if (output)
          await page.screenshot({ path: resolve(output, `nested-${kind}-${theme}-${width}.png`) });
        await page.keyboard.press('Escape');
        await child.waitFor({ state: 'detached' });
        assert.equal(await parent.count(), 1);
        await parent.focus();
        await page.keyboard.press('Escape');
        await parent.waitFor({ state: 'detached' });
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
