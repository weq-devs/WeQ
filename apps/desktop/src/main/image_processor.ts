import { fork, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChildWorkerPath } from './worker_path';
import type { ImageMetadata, ImageReply, ImageRequest, ImageResult } from './image_worker_protocol';
export { PREVIEW_MAX_SIDE } from './image_worker_protocol';

/** sharp 与 QQ wrapper 的 libvips 必须分属不同进程，worker_threads 仍共享 ObjC 运行时。 */
export function createImageProcessor<Request extends object = ImageRequest>(
  options: { workerPath?: string; workerName?: string; idleMs?: number; timeoutMs?: number } = {},
) {
  let worker: ChildProcess | undefined;
  let sequence = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<
    number,
    {
      resolve: (result: ImageResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function close(error = new Error('图片处理进程已关闭')): void {
    const previous = worker;
    worker = undefined;
    clearTimeout(idle);
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    pending.clear();
    previous?.kill();
  }

  function start(): ChildProcess {
    if (worker) return worker;
    const path =
      options.workerPath ??
      resolveChildWorkerPath(
        options.workerName ?? 'imageWorker.mjs',
        dirname(fileURLToPath(import.meta.url)),
      );
    const child = fork(path, [], {
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      serialization: 'advanced',
    });
    worker = child;
    child.on('message', (message: ImageReply) => {
      if (worker !== child) return;
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id);
      clearTimeout(task.timer);
      if ('error' in message) task.reject(new Error(message.error));
      else task.resolve(message.result);
      if (pending.size === 0) {
        child.unref();
        child.channel?.unref();
        idle = setTimeout(() => close(), options.idleMs ?? 30_000);
        idle.unref();
      }
    });
    child.on('error', (error) => {
      if (worker === child) close(error);
    });
    child.on('exit', (code, signal) => {
      if (worker === child) close(new Error(`图片处理进程退出（${signal ?? code}）`));
    });
    child.on('disconnect', () => {
      if (worker === child) close(new Error('图片处理进程连接已断开'));
    });
    return child;
  }

  function run(request: Request): Promise<ImageResult> {
    if (pending.size >= 128) return Promise.reject(new Error('preview capacity'));
    return new Promise((resolve, reject) => {
      try {
        const child = start();
        clearTimeout(idle);
        child.ref();
        child.channel?.ref();
        const id = ++sequence;
        const timer = setTimeout(
          () => close(new Error('图片处理超时')),
          options.timeoutMs ?? 30_000,
        );
        pending.set(id, { resolve, reject, timer });
        child.send({ ...request, id }, (error) => {
          if (error && worker === child) close(error);
        });
      } catch (error) {
        close(error instanceof Error ? error : new Error(String(error)));
        reject(error);
      }
    });
  }

  return { run, close };
}

export const imageProcessor = createImageProcessor();

export async function imageMetadata(
  input: Uint8Array | string,
  maxPixels: number,
): Promise<ImageMetadata> {
  return (await imageProcessor.run({ operation: 'metadata', input, maxPixels })) as ImageMetadata;
}

export async function imageThumbnail(
  input: Uint8Array,
  maxPixels: number,
  preserveAnimation: boolean,
): Promise<Buffer> {
  return (await imageProcessor.run({
    operation: 'preview',
    input,
    maxPixels,
    preserveAnimation,
  })) as Buffer;
}
