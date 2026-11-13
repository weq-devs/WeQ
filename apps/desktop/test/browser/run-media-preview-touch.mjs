import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { createServer } from 'vite';
import sharp from 'sharp';
import { runMediaPreviewTouch } from './media-preview-touch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(process.env.WEQ_PLAYWRIGHT_IMPORT ?? 'playwright');
await mkdir(resolve(root, 'node_modules/.cache'), { recursive: true });
const cache = await mkdtemp(resolve(root, 'node_modules/.cache/media-preview-touch-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(cache, 'vite'),
  plugins: [react(), tailwind()],
  define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web') },
  optimizeDeps: {
    entries: ['test/browser/media-preview.html'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime', 'zustand'],
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^.*\/trpc\/client$/,
        replacement: resolve(root, 'test/browser/media-preview.stub.ts'),
      },
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
let browser;
try {
  const picture = await sharp({
    create: { width: 640, height: 480, channels: 3, background: '#247954' },
  })
    .png()
    .toBuffer();
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.WEQ_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEQ_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({ reducedMotion: 'reduce', hasTouch: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (url.pathname.startsWith('/_media/'))
      return route.fulfill({ contentType: 'image/png', body: picture });
    return route.continue();
  });
  const output = process.env.WEQ_MEDIA_PREVIEW_ARTIFACTS;
  if (output) await mkdir(output, { recursive: true });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/test/browser/media-preview.html`,
    { waitUntil: 'networkidle' },
  );
  const touchCases = await runMediaPreviewTouch(page, output);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ touchCases, errors }));
} finally {
  await browser?.close();
  await server.close();
  await rm(cache, { recursive: true, force: true });
}
