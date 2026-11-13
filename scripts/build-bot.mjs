import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildBotRuntime(outdir = resolve(root, 'resources/bot-runtime')) {
  await build({
    absWorkingDir: root,
    entryPoints: {
      bot: 'packages/bot/src/index.ts',
      ocrWorker: 'packages/agentlab/src/ocr/worker.ts',
    },
    outdir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['bufferutil', 'utf-8-validate', 'sharp', 'onnxruntime-node'],
    banner: {
      js: "import { createRequire as __cjs_createRequire } from 'node:module'; const require = __cjs_createRequire(import.meta.url);",
    },
  });
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await buildBotRuntime();
