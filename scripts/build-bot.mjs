import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildBotRuntime(
  outdir = resolve(root, 'resources/bot-runtime'),
  { metafile } = {},
) {
  const result = await build({
    ...(metafile ? { metafile: true } : {}),
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
  if (metafile && result.metafile) await writeFile(metafile, JSON.stringify(result.metafile));
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  // 开发启动器用环境变量传递元数据路径：脚本参数在 Windows 上会被 cmd.exe 拆开。
  await buildBotRuntime(undefined, { metafile: process.env.WEQ_BOT_METAFILE || undefined });
