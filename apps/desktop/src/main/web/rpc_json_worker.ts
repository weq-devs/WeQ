import { Worker } from 'node:worker_threads';

const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const IDLE_MS = 15_000;
const parserSource = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, chunks, bytes }) => {
  try {
    const body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    parentPort.postMessage({ id, body });
  } catch {
    parentPort.postMessage({ id, invalid: true });
  }
});
`;

type ParseReply = { id: number } & ({ body: unknown } | { invalid: true });
type ParseTask = { bytes: number; resolve(body: unknown): void; reject(error: Error): void };
const pending = new Map<number, ParseTask>();
let worker: Worker | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queuedBytes = 0;
let sequence = 0;

function closeParser(current: Worker) {
  if (current !== worker) return;
  clearTimeout(idleTimer);
  worker = undefined;
  for (const task of pending.values()) task.reject(new Error('请求解析线程已关闭'));
  pending.clear();
  queuedBytes = 0;
  void current.terminate().catch(() => undefined);
}

function startParser() {
  const current = new Worker(parserSource, { eval: true });
  worker = current;
  current.on('error', () => closeParser(current));
  current.on('exit', () => closeParser(current));
  current.on('message', (reply: ParseReply) => {
    if (worker !== current) return;
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    queuedBytes -= task.bytes;
    if (!pending.size) {
      current.unref();
      idleTimer = setTimeout(() => closeParser(current), IDLE_MS);
      idleTimer.unref();
    }
    if ('invalid' in reply) task.reject(new SyntaxError('请求 JSON 无效'));
    else task.resolve(reply.body);
  });
  return current;
}

/** 大请求的拼接、UTF-8 转换与 JSON 解析不占用服务请求的线程。 */
export async function parseLargeRpcJson(
  chunks: readonly Buffer[],
  bytes: number,
): Promise<unknown> {
  if (queuedBytes + bytes > MAX_QUEUED_BYTES) throw new Error('请求解析线程繁忙');
  const current = worker ?? startParser();
  clearTimeout(idleTimer);
  current.ref();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { bytes, resolve, reject });
    queuedBytes += bytes;
    try {
      // IncomingMessage 的 Buffer 可能与其它片共享内存，只移交本次请求自有的片。
      const owned = chunks.map((chunk) => new Uint8Array(chunk));
      current.postMessage(
        { id, chunks: owned, bytes },
        owned.map((chunk) => chunk.buffer),
      );
    } catch {
      closeParser(current);
    }
  });
}
