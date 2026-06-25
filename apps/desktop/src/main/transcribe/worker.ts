/**
 * Voice-transcription worker — runs the native sherpa-onnx recognizer in a
 * forked child process.
 *
 * Why a child process: the sherpa-onnx C++ runtime can SIGSEGV on some
 * systems, and a crash in a child only fails this one transcription instead of
 * taking down the whole Electron main process. The parent (`engine.ts`) forks
 * this, `send`s the params, and waits for a `final` / `error` message.
 *
 * Bundled by electron-vite as a SEPARATE entry (`transcribeWorker.js`) next to
 * the main `index.js`, with `sherpa-onnx-node` left external (required from
 * node_modules at runtime, unpacked from the asar — see electron-builder.yml).
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const requireFn = createRequire(__filename);

interface WorkerParams {
  /** sense-voice etc. */
  engine: string;
  modelPath: string;
  tokensPath: string;
  /** Raw 16 kHz mono WAV bytes (44-byte header + PCM16LE). */
  wavData: Buffer | Uint8Array | { type: 'Buffer'; data: number[] };
  sampleRate: number;
  languages?: string[];
}

/** Every `<|...|>` technical / emotion / event tag SenseVoice can emit. */
const TAG_RE = /<\|[^|]*\|>/g;

/** Strip all sherpa control tags and collapse whitespace → plain text. */
function toPlainText(text: string): string {
  if (!text) return '';
  return text.replace(TAG_RE, '').replace(/\s+/g, ' ').trim();
}

/**
 * Add the platform package's directory (which holds the `.node` binding and
 * its companion `.dll`s) to PATH so the native module loads. We locate it via
 * `require.resolve` from `sherpa-onnx-node`'s own context (robust under pnpm's
 * nested layout), then fall back to the packaged app.asar.unpacked layout.
 */
function prepareSherpaRuntimeEnv(): void {
  const platform = process.platform === 'win32' ? 'win' : process.platform;
  const platformPkg = `sherpa-onnx-${platform}-${process.arch}`;

  const candidates: string[] = [];
  // Preferred: resolve the platform package relative to sherpa-onnx-node.
  try {
    const nodePkg = requireFn.resolve('sherpa-onnx-node/package.json');
    candidates.push(join(dirname(nodePkg), '..', platformPkg));
  } catch {
    /* not resolvable here — fall through to path guesses */
  }
  try {
    candidates.push(dirname(requireFn.resolve(`${platformPkg}/package.json`)));
  } catch {
    /* ignore */
  }
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    candidates.push(join(resourcesPath, 'app.asar.unpacked', 'node_modules', platformPkg));
  }
  candidates.push(join(process.cwd(), 'node_modules', platformPkg));

  const dirs = candidates.filter((d) => d && existsSync(d));

  if (process.platform === 'win32') {
    const existing = process.env.PATH ?? '';
    process.env.PATH = Array.from(new Set([...dirs, ...existing.split(';').filter(Boolean)])).join(';');
  } else if (process.platform === 'darwin') {
    const key = 'DYLD_LIBRARY_PATH';
    const existing = process.env[key] ?? '';
    process.env[key] = Array.from(new Set([...dirs, ...existing.split(':').filter(Boolean)])).join(':');
  } else {
    const key = 'LD_LIBRARY_PATH';
    const existing = process.env[key] ?? '';
    process.env[key] = Array.from(new Set([...dirs, ...existing.split(':').filter(Boolean)])).join(':');
  }
}

function emit(msg: { type: 'final'; text: string } | { type: 'error'; error: string }): void {
  if (typeof process.send === 'function') process.send(msg);
}

function normalizeBuffer(data: WorkerParams['wavData']): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data && typeof data === 'object' && (data as { type?: string }).type === 'Buffer' && Array.isArray((data as { data?: unknown }).data)) {
    return Buffer.from((data as { data: number[] }).data);
  }
  return Buffer.alloc(0);
}

function run(params: WorkerParams): void {
  try {
    prepareSherpaRuntimeEnv();

    let sherpa: { OfflineRecognizer: new (cfg: unknown) => OfflineRecognizer };
    try {
      sherpa = requireFn('sherpa-onnx-node');
    } catch (e) {
      emit({ type: 'error', error: '语音识别引擎加载失败: ' + String(e) });
      process.exit(1);
      return;
    }

    const wav = normalizeBuffer(params.wavData);
    if (wav.length <= 44) {
      emit({ type: 'final', text: '' });
      process.exit(0);
      return;
    }

    // SenseVoice config (mirrors the sherpa-onnx-node SenseVoice example).
    const recognizer = new sherpa.OfflineRecognizer({
      modelConfig: {
        senseVoice: { model: params.modelPath, useInverseTextNormalization: 1 },
        tokens: params.tokensPath,
        numThreads: 2,
        debug: 0,
      },
    });

    // Strip the 44-byte WAV header → PCM16LE → Float32 in [-1, 1).
    const pcm = wav.subarray(44);
    const samples = new Float32Array(pcm.length >> 1);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = pcm.readInt16LE(i * 2) / 32768;
    }

    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: params.sampleRate, samples });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);

    emit({ type: 'final', text: toPlainText(result?.text ?? '') });
    process.exit(0);
  } catch (e) {
    emit({ type: 'error', error: String(e) });
    process.exit(1);
  }
}

/** Minimal shape of the sherpa-onnx recognizer used here. */
interface OfflineRecognizer {
  createStream(): { acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void };
  decode(stream: unknown): void;
  getResult(stream: unknown): { text?: string };
}

// Params arrive once via IPC from the parent. Bail if the parent disconnects.
let started = false;
process.once('message', (msg) => {
  if (started) return;
  started = true;
  run(msg as WorkerParams);
});
process.once('disconnect', () => process.exit(0));
