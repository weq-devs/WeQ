// @vitest-environment node
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it.each([false, true])(
  '实体转写 worker 从解包目录加载依赖并送达 IPC（加载失败=%s）',
  async (fail) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-transcribe-worker-'));
    const main = join(root, 'Resources/out/main');
    const sherpa = join(root, 'Resources/app.asar.unpacked/node_modules/sherpa-onnx-node');
    mkdirSync(main, { recursive: true });
    mkdirSync(sherpa, { recursive: true });
    writeFileSync(join(root, 'Resources/app.asar'), 'fixture');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(sherpa, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
    writeFileSync(
      join(sherpa, 'index.cjs'),
      fail
        ? 'throw new Error("fixture-sherpa-load-failed" + "x".repeat(256_000) + "fixture-error-end");'
        : `exports.OfflineRecognizer = class {
    createStream() { return { acceptWaveform() {} }; }
    decode() {}
    getResult() { return { text: 'fixture-unpacked-sherpa' }; }
  };`,
    );
    const source = join(__dirname, '../src/main/transcribe');
    for (const [input, output] of [
      ['worker.ts', 'transcribeWorker.mjs'],
      ['tags.ts', 'tags'],
    ]) {
      const compiled = ts.transpileModule(readFileSync(join(source, input!), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
      writeFileSync(
        join(main, output!),
        `import {fileURLToPath as workerFile} from 'node:url'; const __filename = workerFile(import.meta.url);\n${compiled}`,
      );
    }
    const child = fork(join(main, 'transcribeWorker.mjs'), [], {
      execArgv: [],
      cwd: dirname(root),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      env: { ...process.env, NODE_PATH: '' },
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const message = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`worker 超时：${stderr}`)), 5_000);
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`worker 提前退出 ${code}：${stderr}`)));
      });
      child.send({ wavData: Buffer.alloc(46), sampleRate: 16000 });
      if (fail) {
        expect(await message).toEqual({
          type: 'error',
          error: expect.stringContaining('fixture-error-end'),
        });
      } else {
        expect(await message).toEqual({
          type: 'final',
          text: 'fixture-unpacked-sherpa',
          emotion: null,
          events: [],
        });
      }
      expect(await closed).toBe(fail ? 1 : 0);
    } finally {
      clearTimeout(timer);
      child.kill();
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
