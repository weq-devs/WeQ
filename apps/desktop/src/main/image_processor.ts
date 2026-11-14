import { fork, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChildWorkerPath } from './worker_path';
import type { ImageMetadata, ImageReply, ImageRequest, ImageResult } from './image_worker_protocol';
export { PREVIEW_MAX_SIDE } from './image_worker_protocol';

/** 只有原生崩溃才说明这个 worker 运行时本身不可用，普通超时可以换一张图重试。 */
const NATIVE_CRASH_SIGNALS = new Set<NodeJS.Signals>([
  'SIGSEGV',
  'SIGABRT',
  'SIGBUS',
  'SIGILL',
  'SIGTRAP',
]);

/** sharp 与 QQ wrapper 的 libvips 必须分属不同进程，worker_threads 仍共享 ObjC 运行时。 */
export function createImageProcessor<Request extends object = ImageRequest>(
  options: { workerPath?: string; workerName?: string; idleMs?: number; timeoutMs?: number } = {},
) {
  let worker: ChildProcess | undefined;
  let sequence = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  // sharp 的原生崩溃（典型是 Linux/Electron 的 glib 符号冲突）不是单张图片的
  // 问题：同一个二进制每次 fork 都会在解码阶段段错误。记住第一次崩溃，后续请求
  // 直接快速失败，交给上层走原图/缩略图回退，避免反复 fork + core dump。
  let unavailable: string | undefined;
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
    let served = false;
    child.on('message', (message: ImageReply) => {
      if (worker !== child) return;
      served = true;
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
      if (worker !== child) return;
      if (pending.size > 0) unavailable = `图片处理进程不可用（${error.message}）`;
      close(error);
    });
    child.on('exit', (code, signal) => {
      if (worker !== child) return;
      // 还没成功回过任何消息就退出，通常是 sharp/原生库加载失败；原生崩溃信号
      // 则说明运行环境本身不兼容（Linux/Electron 的 glib 冲突）。两种都只会在
      // 之后的每次 fork 里重演，标记不可用让上层直接走原图回退。
      if (pending.size > 0 && (!served || (signal && NATIVE_CRASH_SIGNALS.has(signal)))) {
        unavailable = `图片处理进程不可用（${signal ?? code}）`;
      }
      close(new Error(`图片处理进程退出（${signal ?? code}）`));
    });
    child.on('disconnect', () => {
      if (worker !== child) return;
      // 进程崩掉时 disconnect 可能先于 exit 到达；此时还没收回任何结果，和
      // exit 里的「没服务过就退出」是同一类不可用状态。
      if (pending.size > 0 && !served) unavailable = '图片处理进程连接已断开';
      close(new Error('图片处理进程连接已断开'));
    });
    return child;
  }

  function run(request: Request): Promise<ImageResult> {
    if (unavailable) return Promise.reject(new Error(unavailable));
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

  return { run, close, isUnavailable: () => unavailable !== undefined };
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
