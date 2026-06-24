import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Workspace packages export TS source directly (no build step). They must
 * be bundled into main/preload — not externalized — so Node doesn't try
 * to `import "./index.ts"` at runtime.
 */
const EXCLUDE_FROM_EXTERNAL = [
  '@weq/account',
  '@weq/codec',
  '@weq/db',
  '@weq/native',
  '@weq/platform',
  '@weq/service',
  '@weq/shared',
  '@weq/types',
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: EXCLUDE_FROM_EXTERNAL })],
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
        '@shared': resolve(__dirname, '../../packages/shared/src'),
      },
    },
    build: {
      rollupOptions: {
        // The voice-transcription recognizer runs in a forked child process,
        // so it must be a SEPARATE entry the main process can `fork()` by path.
        // The worker is emitted as `.mjs` so Node always loads it as ESM —
        // including when packaged & asar-unpacked, where the nearest
        // package.json (and its `"type":"module"`) is no longer in scope.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          transcribeWorker: resolve(__dirname, 'src/main/transcribe/worker.ts'),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === 'transcribeWorker' ? 'transcribeWorker.mjs' : '[name].js',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, '../../packages/shared/src'),
        '@resources': resolve(__dirname, '../../resources'),
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
