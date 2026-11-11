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
  cacheDir: resolve(root, 'node_modules/.vite-settings-audit'),
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
const out = process.env.WEQ_SETTINGS_AUDIT_ARTIFACTS;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  if (out) await mkdir(out, { recursive: true });
  const errors = [];
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const base = (error) =>
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/settings-draft-copies.html${error ? '?error=1' : ''}`;
  const results = [];
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.goto(base(false));
      await page.evaluate((theme) => {
        window.draftCopiesQa.theme.getState().setPreference(theme);
        window.draftCopiesQa.theme.getState().setAccent(theme === 'light' ? '#b5243e' : '#81c995');
      }, theme);
      await page.waitForTimeout(600);
      if (out) await page.screenshot({ path: resolve(out, `draft-copies-${width}-${theme}.png`) });
      results.push({
        width,
        theme,
        info: await page.evaluate(() => {
          const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
          return {
            title: text('.weq-dialog-title'),
            labels: [...document.querySelectorAll('.weq-draft-copies label')].map((n) =>
              n.textContent.trim(),
            ),
            textareas: [...document.querySelectorAll('.weq-draft-copies textarea')].map((n) =>
              (n.value || '').slice(0, 60),
            ),
            actions: [...document.querySelectorAll('.weq-draft-copies-actions button')].map((n) =>
              n.textContent.trim(),
            ),
          };
        }),
      });
      // 查看全文：是否真的展开全文
      const viewAll = page.getByRole('button', { name: '查看全文' }).first();
      if (await viewAll.count()) {
        await viewAll.click();
        await page.waitForTimeout(400);
        results.push({
          width,
          theme,
          action: 'view-all',
          value: await page.evaluate(
            () => document.querySelector('.weq-draft-copies textarea')?.value?.slice(0, 80) ?? null,
          ),
        });
        await page.screenshot({ path: resolve(out, `draft-copies-${width}-${theme}-viewall.png`) });
      }
    }
  }
  // 同步失败横幅
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(base(true));
    await page.waitForTimeout(700);
    await page.evaluate(() =>
      window.draftCopiesQa.preferences.setState({
        error: '共享设置读取失败：无法连接电脑端服务，修改暂时只保存在本机。',
      }),
    );
    await page.waitForTimeout(300);
    if (out) await page.screenshot({ path: resolve(out, `sync-error-${width}.png`) });
    results.push({
      width,
      action: 'sync-error',
      info: await page.evaluate(() => {
        const banner = document.querySelector('.weq-sync-status');
        const box = banner?.getBoundingClientRect();
        return {
          visible: Boolean(banner),
          text: banner?.textContent?.trim() ?? null,
          rect: box
            ? {
                x: Math.round(box.x),
                y: Math.round(box.y),
                w: Math.round(box.width),
                h: Math.round(box.height),
              }
            : null,
          overlapsModal: (() => {
            const modal = document.querySelector('.weq-message-modal .weq-dialog');
            if (!modal || !banner) return null;
            const a = modal.getBoundingClientRect();
            if (!box) return null;
            return !(box.bottom < a.top || box.top > a.bottom);
          })(),
        };
      }),
    });
  }
  console.log(JSON.stringify({ results, errors: errors.slice(0, 6) }, null, 1));
} finally {
  await browser?.close();
  await server.close();
}
