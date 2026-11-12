import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';
import type { AccountSession } from '@weq/account';
import { UnreadInfoService } from '../../../../packages/service/src/account/unread_info';
import {
  QQ_UNREAD_COVERAGE,
  VERIFIED_QQ_UNREAD_LAYOUT,
} from '../../../../packages/service/src/account/unread_count_source';
import type { QqUnreadSnapshot } from '@weq/native';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const target = { chatType: 1, uid: 'u_fixture' };
let latest = '100',
  readSeq = 90,
  count = 10;
let cold: ((snapshot: QqUnreadSnapshot) => void) | undefined;
let first = true;
const memory = (): QqUnreadSnapshot => ({
  success: true,
  code: 'ok',
  message: '',
  rows: [{ ...target, unreadCount: count }],
  missingTargets: [],
  generation: 'fixture',
  coverage: QQ_UNREAD_COVERAGE,
  layout: VERIFIED_QQ_UNREAD_LAYOUT,
  fromCache: !first,
  locateMs: 0,
  elapsedMs: 17,
});
function createService() {
  latest = '100';
  readSeq = 90;
  count = 10;
  first = true;
  cold = undefined;
  return new UnreadInfoService(
    {
      selfUid: 'u_self',
      context: { uin: '10001' },
      msgDbPath: '/synthetic/unread.db',
      unreadInfo: {
        getUnreadInfos: async (targets: (typeof target)[], self?: object) =>
          targets.map((t) => ({
            ...t,
            peer: `${t.chatType}_${t.uid}`,
            latestSeq: latest,
            msgSeq: readSeq,
            ...(self ? { outgoingSeqs: [] } : {}),
          })),
      },
    } as unknown as AccountSession,
    undefined,
    undefined,
    {
      identity: () => 'synthetic',
      clear() {},
      read: async () => {
        if (first) {
          first = false;
          return new Promise((done) => {
            cold = done;
          });
        }
        return memory();
      },
    },
  );
}
let service = createService();
const output = process.env.WEQ_UNREAD_ARTIFACTS;
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-unread-counts'),
  optimizeDeps: { entries: ['test/browser/unread-counts.html'] },
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  plugins: [
    react(),
    tailwind(),
    {
      name: 'unread-fixture',
      configureServer(server) {
        server.middlewares.use('/__unread', (_request, response, next) => {
          void service.getUnreadInfos([target]).then((rows) => {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(rows));
          }, next);
        });
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: resolve(root, 'test/browser/trpc.stub.ts') },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: [resolve(root, '../..')] },
  },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const address = server.httpServer!.address();
  assert(address && typeof address !== 'string');
  if (output) await mkdir(output, { recursive: true });
  const results: object[] = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['light', 'dark']) {
      await service.dispose();
      service = createService();
      await page.goto(`http://127.0.0.1:${address.port}/test/browser/unread-counts.html`);
      await page.locator('.conversation-row').waitFor();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const step of [
        { name: 'cold', latest: '100', read: 90, count: 10, expected: 10 },
        { name: 'read-six', latest: '100', read: 90, count: 10, expected: 4, local: '96' },
        { name: 'new-one', latest: '101', read: 90, count: 11, expected: 5 },
        { name: 'qq-three', latest: '100', read: 93, count: 7, expected: 4 },
        { name: 'same-count', latest: '102', read: 92, count: 10, expected: 6 },
        { name: 'confirmed', latest: '104', read: 100, count: 4, expected: 4 },
      ]) {
        latest = step.latest;
        readSeq = step.read;
        count = step.count;
        if (step.local) await service.markLocalRead(1, target.uid, step.local);
        const value = await page.evaluate(async () => {
          const qa = (window as unknown as { unreadQa: { refresh(): Promise<number> } }).unreadQa;
          return qa.refresh();
        });
        assert.equal(value, step.expected);
        await page.waitForFunction(
          (expected) => document.querySelector('.row-unread')?.textContent === String(expected),
          step.expected,
        );
        const bounds = await page.locator('.row-unread').boundingBox();
        assert(bounds && bounds.width > 0 && bounds.height > 0);
        assert(
          bounds.width < 40,
          `角标尺寸异常: ${JSON.stringify(
            await page.evaluate(() => {
              const selectors = ['.conversation-row', '.row-meta', '.row-unread'];
              return selectors.map((selector) => {
                const el = document.querySelector(selector)!;
                const css = getComputedStyle(el);
                return {
                  selector,
                  rect: el.getBoundingClientRect().toJSON(),
                  display: css.display,
                  position: css.position,
                  gridArea: css.gridArea,
                  grid: css.gridTemplateColumns,
                  flexDirection: css.flexDirection,
                  alignItems: css.alignItems,
                };
              });
            }),
          )}`,
        );
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width);
        results.push({ width, theme, step: step.name, count: value });
        if (step.name === 'cold') {
          cold?.(memory());
          cold = undefined;
        }
      }
      if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
    }
  }
  assert.deepEqual(errors, []);
  if (output)
    await writeFile(resolve(output, 'report.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ cases: results.length, results, errors }, null, 2));
} finally {
  await service.dispose();
  await browser?.close();
  await server.close();
}
