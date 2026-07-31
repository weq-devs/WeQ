import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The browser build reuses the desktop renderer verbatim. Only two things
 * differ, both resolved here:
 *
 *   - `@transport` → the HTTP + WebSocket tRPC links (instead of `ipcLink`)
 *   - `VITE_WEQ_TARGET` → 'web', which flips the media/asset URL prefixes and
 *     tree-shakes every `<DesktopOnly>` branch out of the bundle
 */

const RENDERER = resolve(__dirname, '../desktop/src/renderer');

export default defineConfig({
  root: RENDERER,
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web'),
  },
  resolve: {
    alias: {
      '@renderer': resolve(RENDERER, 'src'),
      '@resources': resolve(__dirname, '../../resources'),
      '@transport': resolve(RENDERER, 'src/trpc/transport.web.ts'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/public'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(RENDERER, 'index.html') },
    },
  },
});
