import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
const stub = resolve(root, 'test/browser/contact-card.stub.ts');
const out = process.env.WEQ_PROFILE_AUDIT_ARTIFACTS ?? '/tmp/weq-qa/shots/card';
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, 'node_modules/.vite-profile-audit'),
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      { find: /^.*\/trpc\/client$/, replacement: stub },
      { find: /^.*\/hooks\/useQQWriteSession$/, replacement: stub },
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
await server.listen();
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const base = `http://127.0.0.1:${server.httpServer.address().port}/test/browser/profile-audit.html`;
async function shot(name, query, { width = 1280, height = 900, theme = 'light', prep } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  page.on('pageerror', (e) => console.log('PAGEERROR', name, e.message));
  await page.route('**/*', (r) =>
    new URL(r.request().url()).hostname === '127.0.0.1' || r.request().url().startsWith('data:')
      ? r.continue()
      : r.abort(),
  );
  await page.addInitScript(
    ({ theme }) => {
      const apply = () => {
        if (!document.documentElement) return;
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty(
          '--weq-accent-effective',
          theme === 'dark' ? '#47bc97' : '#c64556',
        );
      };
      apply();
      document.addEventListener('DOMContentLoaded', apply);
    },
    { theme },
  );
  await page.goto(`${base}?${query}`);
  await page.waitForTimeout(500);
  if (prep) await prep(page);
  await page.screenshot({ path: resolve(out, `${name}.png`) });
  const info = await page.evaluate(() => ({
    view: document.getElementById('audit-view')?.textContent,
    headings: [...document.querySelectorAll('h1,h2,h3')].map(
      (n) => `${n.tagName}:${n.textContent.trim().slice(0, 18)}`,
    ),
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 180),
  }));
  console.log(name, JSON.stringify(info));
  await page.close();
}
const mode = (m) => async (page) => {
  await page.evaluate((m) => {
    window.profileAuditQa.mode = m;
    window.profileAuditQa.notify();
  }, m);
  await page.waitForTimeout(250);
};
await shot('card-self-1280-light', 'view=card&state=self');
await shot('card-bot-1280-light', 'view=card&state=default', { prep: mode('bot') });
await shot('card-enterprise-390-light', 'view=card&state=default', {
  width: 390,
  height: 780,
  prep: mode('enterprise'),
});
await shot('card-clone-1280-light', 'view=card&state=default', { prep: mode('clone') });
await shot('card-error-1280-light', 'view=card&state=default', {
  prep: async (page) => {
    await page.evaluate(() => {
      window.profileAuditQa.failLabels = true;
      window.profileAuditQa.notify();
    });
    await page.waitForTimeout(600);
  },
});
await shot('page-details-1280-light', 'view=page&state=default&tab=details');
await shot('page-marks-1280-light', 'view=page&state=default&tab=marks');
await shot('page-group-1280-light', 'view=page&state=default&tab=group');
await shot('page-history-1280-light', 'view=page&state=default&tab=history');
await shot('page-details-390-light', 'view=page&state=default&tab=details', {
  width: 390,
  height: 780,
});
await shot('settings-320-dark', 'view=settings&state=default', {
  width: 320,
  height: 780,
  theme: 'dark',
});
await browser.close();
await server.close();
