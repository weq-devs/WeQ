import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const requireCodec = createRequire(import.meta.url);
const idleMs = 15_000;
// 复用随 Electron 或 Web 服务安装的 codec，归档里的 JS 与 WASM 仍由 Electron 读取。
const playbackWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { decode } = require(workerData);
parentPort.on('message', async ({ id, input, sampleRate }) => {
  try {
    const { data } = await decode(input, sampleRate);
    parentPort.postMessage({ id, data }, [data.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: String(error.message ?? error) });
  }
});
`;

type PlaybackReply = { id: number } & ({ data: Uint8Array } | { error: string });
type PlaybackTask = { resolve(data: Uint8Array): void; reject(error: Error): void };

let worker: Worker | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;
const pending = new Map<number, PlaybackTask>();

function closeWorker(current: Worker, error?: Error): void {
  if (worker !== current) return;
  worker = undefined;
  clearTimeout(idleTimer);
  for (const task of pending.values()) task.reject(error ?? new Error('语音解码线程已关闭'));
  pending.clear();
  void current.terminate().catch(() => undefined);
}

function startWorker(): Worker {
  const current = new Worker(playbackWorkerSource, {
    eval: true,
    workerData: requireCodec.resolve('silk-wasm'),
  });
  worker = current;
  current.on('error', (error) => closeWorker(current, error));
  current.on('exit', (code) => closeWorker(current, new Error(`语音解码线程退出（${code}）`)));
  current.on('message', (message: PlaybackReply) => {
    if (worker !== current) return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (pending.size === 0) {
      current.unref();
      idleTimer = setTimeout(() => closeWorker(current), idleMs);
      idleTimer.unref();
    }
    if ('error' in message) task.reject(new Error(message.error));
    else task.resolve(message.data);
  });
  return current;
}

/** 播放可能解码长语音，WASM 运行在线程中，缓存命中无需启动线程。 */
export async function decodePlayback(input: Uint8Array, sampleRate: number): Promise<Uint8Array> {
  const current = worker ?? startWorker();
  clearTimeout(idleTimer);
  current.ref();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      const bytes = new Uint8Array(input);
      current.postMessage({ id, input: bytes, sampleRate }, [bytes.buffer]);
    } catch (error) {
      closeWorker(current, error instanceof Error ? error : new Error(String(error)));
    }
  });
}
