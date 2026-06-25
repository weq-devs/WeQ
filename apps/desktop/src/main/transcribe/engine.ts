/**
 * Recognition engine — the Electron-main side of voice transcription.
 *
 * Forks `transcribeWorker.js` (bundled next to this module's output as a
 * separate electron-vite entry), hands it the model paths + 16 kHz WAV bytes,
 * and resolves with the recognized text. The worker isolation guards the main
 * process from a sherpa-onnx SIGSEGV — see worker.ts.
 *
 * Native (sherpa-onnx) lives here in the app, not in `@weq/service`: the model
 * MANAGEMENT (download/select) is zero-native and lives in the service package
 * (`VoiceTranscribeService`); this module only runs the engine.
 */

import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the bundled `transcribeWorker.mjs`. electron-vite emits it at
 * `out/main/transcribeWorker.mjs`, but this module may be chunked into
 * `out/main/chunks/`, so `__dirname` isn't guaranteed to be `out/main`. Try the
 * sibling path first, then one level up (the chunks case).
 */
function resolveWorkerPath(): string {
  const candidates = [
    join(__dirname, 'transcribeWorker.mjs'),
    join(__dirname, '..', 'transcribeWorker.mjs'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

export interface TranscribeResult {
  success: boolean;
  text?: string;
  error?: string;
}

export interface TranscribeModelPaths {
  /** Path to the model file (.onnx). */
  model: string;
  /** Path to the tokens file (tokens.txt). */
  tokens: string;
}

/**
 * Transcribe 16 kHz mono WAV bytes with the given sherpa model. `engine`
 * selects the recognizer config inside the worker (currently 'sense-voice').
 */
export function transcribeWav(
  wav: Buffer,
  paths: TranscribeModelPaths,
  options: { engine?: string; languages?: string[] } = {},
): Promise<TranscribeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: TranscribeResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let worker: ReturnType<typeof fork>;
    try {
      // Bundled output sits alongside the main entry in out/main/.
      const workerPath = resolveWorkerPath();
      worker = fork(workerPath, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
      });
    } catch (e) {
      done({ success: false, error: String(e) });
      return;
    }

    worker.on('message', (msg: { type?: string; text?: string; error?: string }) => {
      if (msg?.type === 'final') {
        done({ success: true, text: msg.text ?? '' });
        worker.disconnect();
        worker.kill();
      } else if (msg?.type === 'error') {
        done({ success: false, error: msg.error });
        worker.disconnect();
        worker.kill();
      }
    });

    worker.on('error', (err) => done({ success: false, error: String(err) }));
    worker.on('exit', (code, signal) => {
      if (signal === 'SIGSEGV') {
        done({ success: false, error: '语音识别引擎崩溃（底层运行库段错误）' });
        return;
      }
      if (code !== 0 && code !== null) {
        done({ success: false, error: `识别进程异常退出 (code ${code})` });
      } else {
        // Normal exit after a 'final'/'error' already resolved — no-op.
        done({ success: false, error: '识别进程未返回结果' });
      }
    });

    worker.send({
      engine: options.engine ?? 'sense-voice',
      modelPath: paths.model,
      tokensPath: paths.tokens,
      wavData: wav,
      sampleRate: 16000,
      languages: options.languages ?? [],
    });
  });
}
