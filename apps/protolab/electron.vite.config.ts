import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Workspace packages export TS source directly (no build step). They must be
// bundled into main/preload — not externalized — so Node doesn't try to
// `import "./index.ts"` at runtime.
const EXCLUDE_FROM_EXTERNAL = [
  '@weq/codec',
  '@weq/db',
  '@weq/native',
  '@weq/types',
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: EXCLUDE_FROM_EXTERNAL })],
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: EXCLUDE_FROM_EXTERNAL })],
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
});
