import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tsImport } from 'tsx/esm/api';

const developmentViteLogging: typeof import('../desktop/src/main/development_vite').developmentViteLogging =
  process.env.WEQ_DEV_CONSOLE === '1' && process.env.WEQ_LOG_LEVEL !== 'debug'
    ? (await tsImport('../desktop/src/main/development_vite.ts', import.meta.url))
        .developmentViteLogging
    : () => ({ config: {}, plugins: [] });

/**
 * The browser build reuses the desktop renderer verbatim. Only two things
 * differ, both resolved here:
 *
 *   - `@transport` → the HTTP + WebSocket tRPC links (instead of `ipcLink`)
 *   - `VITE_WEQ_TARGET` → 'web', which flips the media/asset URL prefixes and
 *     tree-shakes every `<DesktopOnly>` branch out of the bundle
 */

const RENDERER = resolve(__dirname, '../desktop/src/renderer');
const logging = developmentViteLogging('web');

export default defineConfig({
  ...logging.config,
  clearScreen: false,
  root: RENDERER,
  plugins: [...logging.plugins, react(), tailwindcss()],
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
    outDir: resolve(process.env.WEQ_WEB_DIST ?? resolve(__dirname, 'dist'), 'public'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(RENDERER, 'index.html') },
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'runtime',
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 20,
            },
            { name: 'icons', test: /node_modules[\\/]lucide-react[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
});
