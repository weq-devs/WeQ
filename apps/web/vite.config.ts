import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tsImport } from 'tsx/esm/api';
import { webChunkBudget } from './scripts/chunk-budget.ts';

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

const RENDERER = resolve(import.meta.dirname, '../desktop/src/renderer');
const logging = developmentViteLogging('web');
const chunkBudget = webChunkBudget();

export default defineConfig({
  ...logging.config,
  clearScreen: false,
  root: RENDERER,
  cacheDir: resolve(import.meta.dirname, 'node_modules/.vite-web'),
  plugins: [...logging.plugins, chunkBudget.plugin, react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_WEQ_TARGET': JSON.stringify('web'),
  },
  resolve: {
    alias: {
      '@renderer': resolve(RENDERER, 'src'),
      '@resources': resolve(import.meta.dirname, '../../resources'),
      '@transport': resolve(RENDERER, 'src/trpc/transport.web.ts'),
    },
  },
  build: {
    manifest: process.env.WEQ_DEV_WEB_CACHE === '1',
    outDir: resolve(process.env.WEQ_WEB_DIST ?? resolve(import.meta.dirname, 'dist'), 'public'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(RENDERER, 'index.html') },
      output: {
        // 聊天模板与业务状态存在交叉引用，分包后仍按源码顺序初始化。
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            {
              name: 'runtime',
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 20,
            },
            { name: 'icons', test: /node_modules[\\/]lucide-react[\\/]/, priority: 10 },
            {
              name: 'html-parser',
              test: /node_modules[\\/](?:parse5|entities)[\\/]/,
              priority: 10,
            },
            {
              name: 'chat-ui',
              // 首页共用的小工具不能把整个聊天分组带入首屏。
              test: /src[\\/]renderer[\\/]src[\\/]im-template[\\/]template[\\/](?!(?:arkPanel|redPacketPanel|locationCardPanel|locationSharePanel|lazyComposerPanels|classNames|conversationDisplay|messageGap|modalUtils|user)\.)/,
              includeDependenciesRecursively: false,
              maxSize: 350_000,
              priority: 10,
            },
            {
              name: 'timeline-virtualizer',
              test: /node_modules[\\/]@tanstack[\\/](?:virtual-core|react-virtual)[\\/]/,
              includeDependenciesRecursively: false,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
