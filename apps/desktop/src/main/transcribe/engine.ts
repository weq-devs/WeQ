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
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { resolveChildWorkerPath } from '../worker_path';
import type { VoiceTagDisplay } from './tags';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface TranscribeResult {
  success: boolean;
  /** Transcript, with every SenseVoice control tag stripped. */
  text?: string;
  /**
   * Speaker tone from the SenseVoice emotion tag (😊 开心 / 😔 难过 …), or null
   * when the clip carried no tag. Present on success only.
   */
  emotion?: VoiceTagDisplay | null;
  /** Sound events the model recognized (🎵 背景音 / 😂 笑声 / 👏 掌声 …). */
  events?: VoiceTagDisplay[];
  error?: string;
}

export interface TranscribeModelPaths {
  /** Path to the model file (.onnx). */
  model: string;
  /** Path to the tokens file (tokens.txt). */
  tokens: string;
}

/** Messages the worker posts back over IPC. */
type TranscribeWorkerMessage =
  | {
      type?: 'final';
      text?: string;
      emotion?: VoiceTagDisplay | null;
      events?: VoiceTagDisplay[];
    }
  | { type?: 'error'; error?: string };

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
      const workerPath = resolveChildWorkerPath('transcribeWorker.mjs', moduleDir);
      worker = fork(workerPath, [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        serialization: 'advanced',
      });
    } catch (e) {
      done({ success: false, error: String(e) });
      return;
    }

    let stderr = '';
    worker.stderr?.setEncoding('utf8');
    worker.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    const stopWorker = (): void => {
      if (worker.connected) worker.disconnect();
      worker.kill();
    };

    worker.on('message', (msg: TranscribeWorkerMessage) => {
      if (msg?.type === 'final') {
        done({
          success: true,
          text: msg.text ?? '',
          emotion: msg.emotion ?? null,
          events: msg.events ?? [],
        });
        stopWorker();
      } else if (msg?.type === 'error') {
        done({ success: false, error: msg.error ?? '语音识别失败' });
        stopWorker();
      }
    });

    worker.on('error', (err) => {
      done({ success: false, error: String(err) });
      stopWorker();
    });
    // close 晚于 exit，确保原生运行库的 stderr 已排空，保留有界诊断。
    worker.on('close', (code, signal) => {
      if (signal === 'SIGSEGV') {
        done({ success: false, error: '语音识别引擎崩溃（底层运行库段错误）' });
        return;
      }
      if (signal || (code !== 0 && code !== null)) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        done({
          success: false,
          error: `识别进程异常退出 (${reason})${stderr.trim() ? `：${stderr.trim()}` : ''}`,
        });
      } else {
        // Normal exit after a 'final'/'error' already resolved — no-op.
        done({ success: false, error: '识别进程未返回结果' });
      }
    });

    worker.send(
      {
        engine: options.engine ?? 'sense-voice',
        modelPath: paths.model,
        tokensPath: paths.tokens,
        wavData: wav,
        sampleRate: 16000,
        languages: options.languages ?? [],
      },
      (error) => {
        if (!error) return;
        done({ success: false, error: `语音识别请求发送失败：${String(error)}` });
        stopWorker();
      },
    );
  });
}
