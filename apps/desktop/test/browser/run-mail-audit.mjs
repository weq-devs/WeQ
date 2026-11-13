import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-mail-audit'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  resolve: {
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/settings-audit.stub.ts'),
      },
      { find: '@renderer', replacement: resolve(root, 'src/renderer/src') },
      { find: '@resources', replacement: resolve(root, '../../resources') },
      { find: '@transport', replacement: resolve(root, 'test/support/transport.stub.ts') },
    ],
  },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
const out = process.env.WEQ_MAIL_AUDIT_ARTIFACTS;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  if (out) await mkdir(out, { recursive: true });
  const errors = [];
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.clear());
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const base = (scenario) =>
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/mail-audit.html?scenario=${scenario}`;
  const report = [];
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ]) {
    for (const theme of ['light', 'dark']) {
      for (const scenario of ['ready', 'empty', 'error', 'connecting']) {
        await page.setViewportSize({ width, height });
        await page.goto(base(scenario));
        await page.evaluate((theme) => {
          window.mailAuditQa.theme.getState().setPreference(theme);
          window.mailAuditQa.theme.getState().setAccent(theme === 'light' ? '#b5243e' : '#81c995');
        }, theme);
        await page.waitForTimeout(700);
        if (out)
          await page.screenshot({
            path: resolve(out, `mail-${width}-${theme}-${scenario}.png`),
          });
        report.push({
          width,
          theme,
          scenario,
          info: await page.evaluate(() => {
            const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
            return {
              syncState: text('.weq-mail-sync-state'),
              errorBanner: text('.weq-mail-error'),
              connectionTitle: text('.weq-mail-connection h2'),
              folderUnread: [...document.querySelectorAll('.weq-mail-folders small')].map((n) =>
                n.textContent.trim(),
              ),
              hasReader: Boolean(document.querySelector('.weq-mail-reader-shell')),
              rowCount: document.querySelectorAll('.weq-mail-row').length,
            };
          }),
        });
      }
    }
  }
  // 点击一封未读邮件，看阅读态与未读处理
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(base('ready'));
  await page.waitForTimeout(600);
  const firstRow = page.locator('.weq-mail-row').first();
  if (await firstRow.count()) {
    await firstRow.click();
    await page.waitForTimeout(600);
    if (out) await page.screenshot({ path: resolve(out, 'mail-1280-light-reader.png') });
    report.push({
      width: 1280,
      theme: 'light',
      scenario: 'reader',
      info: await page.evaluate(() => ({
        subject:
          document.querySelector('.weq-mail-message-heading h2')?.textContent?.trim() ?? null,
        hasDetail: document.body.getAttribute('data-detail'),
        backButton: document
          .querySelector('.weq-mail-reader-tools button')
          ?.getAttribute('aria-label'),
      })),
    });
  }
  console.log(JSON.stringify({ report, errors: errors.slice(0, 6) }, null, 1));
} finally {
  await browser?.close();
  await server.close();
}
