import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ozonePlatformArgs } from './src/main/linux_window_backend';
import { tsImport } from 'tsx/esm/api';

// 配置加载器会外置裸包导入；仅开发摘要需要通过现有 TS 加载器读取工作区源码。
const developmentViteLogging: typeof import('./src/main/development_vite').developmentViteLogging =
  process.env.WEQ_DEV_CONSOLE === '1' && process.env.WEQ_LOG_LEVEL !== 'debug'
    ? (await tsImport('./src/main/development_vite.ts', import.meta.url)).developmentViteLogging
    : () => ({ config: {}, plugins: [] });

/**
 * Workspace packages export TS source directly (no build step). They must
 * be bundled into main/preload — not externalized — so Node doesn't try
 * to `import "./index.ts"` at runtime.
 */
const EXCLUDE_FROM_EXTERNAL = [
  '@weq/agentlab',
  '@weq/account',
  '@weq/codec',
  '@weq/db',
  '@weq/native',
  '@weq/native/authorization.mjs',
  '@weq/platform',
  '@weq/protocol',
  '@weq/service',
  '@weq/service/conversation-calendar',
  '@weq/service/conversation-calendar-store',
  '@weq/service/conversation-calendar-sources',
  '@weq/service/storage-cleanup',
  '@weq/service/db-checkup',
  '@weq/service/bad-pages',
  '@weq/service/search-index-retirement',
  '@weq/types',
  '@weq/time',
  'satori',
  // 备份探测 worker 位于 asar 外，校验协议需随共享 chunks 一起打包。
  'zod',
];

let remoteWebBuilt = false;
const mainLogging = developmentViteLogging('main');
const preloadLogging = developmentViteLogging('preload');
const rendererLogging = developmentViteLogging('renderer');

// Wayland 会话默认让 Electron 走 XWayland（平铺合成器会把 `type: 'toolbar'` 平铺掉）。
// 这个开关**必须出现在 Electron 启动参数里**，`app.commandLine.appendSwitch` 在 ready
// 前调用也来不及 —— 详见 src/main/linux_window_backend.ts。electron-vite 会在本配置
// 加载完之后才读取 `ELECTRON_CLI_ARGS` 并拼到 entry 后面，所以在这里注入最稳妥。
//
// 放在**用户参数前面**：`pnpm dev -- --foo` 会再带一个 `--`，Chromium 只认它前面的
// 开关；排在后面的话 ozone 会被当成应用参数吞掉。
process.env.ELECTRON_CLI_ARGS = JSON.stringify([
  ...ozonePlatformArgs(),
  ...(process.env.ELECTRON_CLI_ARGS ? JSON.parse(process.env.ELECTRON_CLI_ARGS) : []),
]);

export default defineConfig({
  main: {
    ...mainLogging.config,
    clearScreen: false,
    plugins: [
      ...mainLogging.plugins,
      {
        name: 'weq-remote-web-assets',
        buildStart() {
          if (remoteWebBuilt) return;
          const pnpm = process.env.npm_execpath;
          if (!pnpm) throw new Error('请通过 pnpm 运行桌面构建，以同时构建内置 Web 页面。');
          const args = ['--filter', '@weq/web', 'exec', 'vite', 'build'];
          const script = /\.[cm]?js$/.test(pnpm);
          execFileSync(script ? process.execPath : pnpm, script ? [pnpm, ...args] : args, {
            cwd: resolve(import.meta.dirname, '../..'),
            env: { ...process.env, NODE_ENV: 'production' },
            stdio: 'inherit',
            windowsHide: true,
            shell: process.platform === 'win32' && pnpm.endsWith('.cmd'),
          });
          remoteWebBuilt = true;
        },
      },
      externalizeDepsPlugin({ exclude: EXCLUDE_FROM_EXTERNAL }),
    ],
    resolve: {
      alias: {
        '@main': resolve(import.meta.dirname, 'src/main'),
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
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          imageWorker: resolve(import.meta.dirname, 'src/main/image_worker.ts'),
          coverWorker: resolve(import.meta.dirname, 'src/main/cover_worker.ts'),
          analysisReportsWorker: resolve(
            import.meta.dirname,
            '../../packages/service/src/account/analysis_reports_worker.mjs',
          ),
          transcribeWorker: resolve(import.meta.dirname, 'src/main/transcribe/worker.ts'),
          // 本地 OCR 推理同样在子进程里跑（onnxruntime 是原生库，见 main/ocr/worker.ts）。
          ocrWorker: resolve(import.meta.dirname, 'src/main/ocr/worker.ts'),
          attachWorker: resolve(import.meta.dirname, 'src/main/attach_worker.ts'),
          // 抓包会话要以 root 跑（Electron 不能以 root 运行），所以和 attachWorker
          // 一样单独打一个入口，用 `sudo` + `ELECTRON_RUN_AS_NODE` 拉起。
          captureWorker: resolve(import.meta.dirname, 'src/main/capture_worker.ts'),
          // 密钥扫描同理：读别的进程内存要 root，单独打成 root 子进程入口。
          keyScanWorker: resolve(import.meta.dirname, 'src/main/key_scan_worker.ts'),
          storageCleanupWorker: resolve(import.meta.dirname, 'src/main/storage_cleanup_worker.ts'),
          backupProbeWorker: resolve(import.meta.dirname, 'src/main/backup_probe_worker.ts'),
          dbCheckupWorker: resolve(import.meta.dirname, 'src/main/db_checkup_worker.ts'),
          sourceSearchWorker: resolve(import.meta.dirname, 'src/main/source_search_worker.ts'),
          sourceSearchRetirementWorker: resolve(
            import.meta.dirname,
            'src/main/source_search_retirement_worker.ts',
          ),
          macUpdateWorker: resolve(import.meta.dirname, 'src/main/update/mac_worker.ts'),
          // 意图感知本地引擎：Laya ONNX 推理跑在 fork 的子进程（同 transcribeWorker
          // 的打包/寻址约定，主进程经 intent_sense/bridge.ts 持有）。
          intentSenseWorker: resolve(import.meta.dirname, 'src/main/intent_sense/worker.ts'),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === 'imageWorker' ||
            chunk.name === 'coverWorker' ||
            chunk.name === 'analysisReportsWorker' ||
            chunk.name === 'transcribeWorker' ||
            chunk.name === 'ocrWorker' ||
            chunk.name === 'attachWorker' ||
            chunk.name === 'captureWorker' ||
            chunk.name === 'keyScanWorker' ||
            chunk.name === 'storageCleanupWorker' ||
            chunk.name === 'backupProbeWorker' ||
            chunk.name === 'dbCheckupWorker' ||
            chunk.name === 'sourceSearchWorker' ||
            chunk.name === 'sourceSearchRetirementWorker' ||
            chunk.name === 'macUpdateWorker' ||
            chunk.name === 'intentSenseWorker'
              ? `${chunk.name}.mjs`
              : '[name].js',
        },
      },
    },
  },
  preload: {
    ...preloadLogging.config,
    clearScreen: false,
    plugins: [...preloadLogging.plugins, externalizeDepsPlugin()],
  },
  renderer: {
    ...rendererLogging.config,
    clearScreen: false,
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [...rendererLogging.plugins, react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
        '@resources': resolve(import.meta.dirname, '../../resources'),
        // Per-target tRPC transport; the web app aliases this to transport.web.
        '@transport': resolve(import.meta.dirname, 'src/renderer/src/trpc/transport.electron.ts'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          'window-controls': resolve(import.meta.dirname, 'src/renderer/window-controls.html'),
          // 导出长图专用的第二个入口：主进程在**隐藏窗口**里加载它，只挂一张分析卡片。
          // 分开是为了不把整个应用外壳重复启动一遍（见 src/renderer/src/export/main.tsx）。
          export: resolve(import.meta.dirname, 'src/renderer/export.html'),
        },
      },
    },
  },
});
