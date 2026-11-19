import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(
  process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright',
);
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-sidebar-toolbar'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('electron') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/mobile-surfaces.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
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
  const page = await browser.newPage({
    viewport: { width: 1180, height: 900 },
    reducedMotion: 'reduce',
  });
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  const failures = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ||
    route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const output = process.env.WEQ_SIDEBAR_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  let cases = 0;
  for (const unread of [false, true]) {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/test/browser/sidebar-toolbar.html${unread ? '?unread' : ''}`,
    );
    await page.getByRole('button', { name: '会话日历', exact: true }).waitFor();
    for (const layout of ['split', 'single'])
      for (const theme of ['light', 'dark'])
        for (const skin of ['classic', 'retro', 'qqnt']) {
          await page.evaluate(
            ({ layout, theme, skin }) => {
              const store = window.sidebarToolbarQa.theme.getState();
              store.setPreference(theme);
              store.setComponentStyle(skin);
              store.setAccent(theme === 'light' ? '#b5243e' : '#81c995');
              store.setBackground(theme === 'light' ? 'grid' : 'telegram');
              document.documentElement.dataset.weqLayout = layout;
            },
            { layout, theme, skin },
          );
          for (const width of [
            160, 180, 190, 196, 198, 200, 202, 210, 220, 224, 226, 230, 240, 280, 390,
          ]) {
            await page.locator('.toolbar-fixture > .sidebar').evaluateAll((nodes, width) => {
              for (const node of nodes) node.style.width = `${width}px`;
            }, width);
            await page.evaluate(async () => {
              await document.fonts.ready;
              await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
            });
            const result = await page.evaluate(() => {
              const geometry = (sidebar) => {
                const origin = sidebar.getBoundingClientRect();
                const toolbar = sidebar.querySelector('.weq-directory-toolbar');
                const box = toolbar.getBoundingClientRect();
                const styles = getComputedStyle(toolbar);
                return {
                  top: box.top - origin.top,
                  height: box.height,
                  line: styles.borderBottomWidth,
                  lineColor: styles.borderBottomColor,
                  buttons: [...toolbar.querySelectorAll('button')].map((node) => {
                    const rect = node.getBoundingClientRect();
                    return [
                      rect.left - origin.left,
                      rect.top - origin.top,
                      rect.width,
                      rect.height,
                    ];
                  }),
                };
              };
              const messages = geometry(document.querySelector('[data-testid="messages"]'));
              const contacts = geometry(document.querySelector('[data-testid="contacts"]'));
              const notices = [...document.querySelectorAll('.weq-contact-notice-entry')].map(
                (node) => {
                  const label = node.querySelector('.notice-entry-label');
                  const text = node.querySelector('.notice-entry-text');
                  const styles = getComputedStyle(node);
                  const visible = getComputedStyle(text).display !== 'none';
                  text.style.setProperty('display', 'inline', 'important');
                  text.style.flexShrink = '0';
                  const available =
                    node.getBoundingClientRect().width -
                    parseFloat(styles.paddingLeft) -
                    parseFloat(styles.paddingRight);
                  const needed =
                    [...label.children].reduce(
                      (sum, child) => sum + child.getBoundingClientRect().width,
                      0,
                    ) +
                    (label.children.length - 1) * parseFloat(getComputedStyle(label).columnGap);
                  text.removeAttribute('style');
                  return {
                    visible,
                    fits: label.scrollWidth <= label.clientWidth,
                    fitsThreshold: visible ? available >= needed - 0.1 : available < needed + 1.5,
                    available,
                    needed,
                  };
                },
              );
              return { messages, contacts, notices };
            });
            const label = `${layout}/${theme}/${skin}/${width}/${unread}`;
            if (
              JSON.stringify(result.messages) !== JSON.stringify(result.contacts) ||
              result.contacts.line !== '1px' ||
              result.notices.some((item) => !item.fitsThreshold || !item.fits)
            )
              failures.push({ label, ...result });
            if (output && width === 240 && skin === 'qqnt' && layout === 'split')
              await page.screenshot({
                path: resolve(output, `${theme}-${unread}.png`),
                fullPage: true,
              });
            cases++;
          }
        }
  }
  console.log(
    JSON.stringify(
      { cases, failureCount: failures.length, failures: failures.slice(0, 3), errors },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  assert.equal(failures.length, 0);
} finally {
  await browser?.close();
  await server.close();
}
