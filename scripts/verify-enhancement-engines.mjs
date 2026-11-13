import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { tsImport } from 'tsx/esm/api';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactDirectory = join(
  root,
  'apps/desktop/.artifacts/enhancements',
  `${process.platform}-${process.arch}`,
);
const { EnhancementEngineStore } = await tsImport(
  '../apps/desktop/src/main/enhancements/engine_store.ts',
  import.meta.url,
);
const { parseEnhancementEngineManifest } = await tsImport(
  '../apps/desktop/src/shared/enhancement_manifest.ts',
  import.meta.url,
);
const manifest = parseEnhancementEngineManifest(
  JSON.parse(await readFile(join(artifactDirectory, 'manifest.json'), 'utf8')),
);
const workspace = await mkdtemp(join(root, 'apps/desktop/.artifacts/enhancement-smoke-'));
const modelsArgument = process.argv.indexOf('--models-root');
const modelsRoot = modelsArgument >= 0 ? resolve(process.argv[modelsArgument + 1]) : null;
const server = createServer(async (request, response) => {
  const name = basename(new URL(request.url, 'http://localhost').pathname);
  const engine = manifest.engines.find((entry) => basename(entry.url) === name);
  if (!engine) {
    response.writeHead(404).end();
    return;
  }
  const file = join(artifactDirectory, name);
  const size = (await stat(file)).size;
  response.writeHead(200, { 'content-length': size, etag: `"${engine.sha256}"` });
  createReadStream(file).pipe(response);
});

async function worker(name, runtime, messages) {
  const child = fork(join(workspace, `${name}.mjs`), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    env: { ...process.env, WEQ_ENHANCEMENT_RUNTIME: runtime, ELECTRON_RUN_AS_NODE: '1' },
  });
  let diagnostics = '';
  child.stderr.on('data', (bytes) => {
    diagnostics = (diagnostics + bytes).slice(-4096);
  });
  try {
    for (const [request, expected] of messages) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`${name} 超时：${diagnostics}`));
        }, 120_000);
        const cleanup = () => {
          clearTimeout(timer);
          child.off('message', onMessage);
          child.off('exit', onExit);
          child.off('error', onError);
        };
        const onMessage = (message) => {
          cleanup();
          message.type === expected
            ? resolve(message)
            : reject(new Error(`${name}: ${JSON.stringify(message)} ${diagnostics}`));
        };
        const onExit = (code, signal) => {
          cleanup();
          reject(new Error(`${name} 退出 ${code ?? signal}: ${diagnostics}`));
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        child.on('message', onMessage).once('exit', onExit).once('error', onError);
        child.send(request);
      });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
}

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const store = new EnhancementEngineStore(workspace, manifest, {
    fetcher: (url, options) => fetch(`http://127.0.0.1:${port}/${basename(String(url))}`, options),
  });
  const runtime = {};
  for (const artifact of manifest.engines) {
    runtime[artifact.kind] = await store.ensure(artifact.kind);
    assert.equal(store.state(artifact.kind).ready, true);
    if (process.platform === 'darwin') {
      for (const file of artifact.files.filter(
        (file) => !file.link && /\.(node|dylib)$/.test(file.path),
      )) {
        const path = join(runtime[artifact.kind], file.path);
        execFileSync('codesign', ['--verify', '--strict', path], { stdio: 'pipe' });
        const attributes = execFileSync('xattr', ['-l', path], { encoding: 'utf8' });
        assert.ok(!attributes.includes('com.apple.quarantine'), '正常下载不应携带浏览器隔离属性');
      }
    }
    console.log(`[enhancements] ${artifact.kind}: 下载、哈希、安装与 CPU 引擎加载通过`);
  }
  if (modelsRoot) {
    for (const [name, entry] of Object.entries({
      ocrWorker: 'ocr/worker.ts',
      transcribeWorker: 'transcribe/worker.ts',
      intentSenseWorker: 'intent_sense/worker.ts',
    })) {
      await build({
        entryPoints: [join(root, 'apps/desktop/src/main', entry)],
        outfile: join(workspace, `${name}.mjs`),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        external: [
          'onnxruntime-node',
          'sherpa-onnx-node',
          '@receptron/laya',
          '@huggingface/tokenizers',
        ],
        banner: {
          js: 'import {fileURLToPath as __workerFileURLToPath} from "node:url"; const __filename = __workerFileURLToPath(import.meta.url);',
        },
      });
    }
    if (runtime.onnx) {
      const ocrRoot = join(modelsRoot, 'ppocr-v5-mobile');
      await worker('ocrWorker', runtime.onnx, [
        [
          {
            mode: 'ocr',
            width: 64,
            height: 64,
            data: Buffer.alloc(64 * 64 * 3, 255),
            det: join(ocrRoot, 'ch_PP-OCRv5_det_mobile.onnx'),
            rec: join(ocrRoot, 'ch_PP-OCRv5_rec_mobile.onnx'),
            cls: join(ocrRoot, 'ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx'),
            dict: join(ocrRoot, 'ppocrv5_dict.txt'),
            threads: 1,
          },
          'final',
        ],
      ]);
      await worker('ocrWorker', runtime.onnx, [
        [
          {
            mode: 'detect',
            width: 64,
            height: 64,
            data: Buffer.alloc(64 * 64 * 3, 255),
            det: join(modelsRoot, 'ppocr-v6-det-tiny/PP-OCRv6_det_tiny.onnx'),
            threads: 1,
          },
          'final',
        ],
      ]);
      console.log('[enhancements] OCR 与筛图：模型实际加载与推理通过');
      await worker('intentSenseWorker', runtime.onnx, [
        [{ type: 'load', modelDir: join(modelsRoot, 'laya-multilingual') }, 'ready'],
        [{ type: 'analyze', id: 1, text: '你好，今天过得怎么样？' }, 'result'],
      ]);
      console.log('[enhancements] Laya：模型实际加载与意图推理通过');
    }
    if (runtime.sherpa) {
      await worker('transcribeWorker', runtime.sherpa, [
        [
          {
            engine: 'sense-voice',
            modelPath: join(modelsRoot, 'sensevoice/model.int8.onnx'),
            tokensPath: join(modelsRoot, 'sensevoice/tokens.txt'),
            wavData: Buffer.alloc(44 + 16000 * 2),
            sampleRate: 16000,
          },
          'final',
        ],
      ]);
      console.log('[enhancements] SenseVoice：模型实际加载与语音推理通过');
    }
  }
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      modelsChecked: !!modelsRoot,
      engines: manifest.engines.map(({ kind, downloadBytes, installedBytes }) => ({
        kind,
        downloadBytes,
        installedBytes,
      })),
    }),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(workspace, { recursive: true, force: true });
}
