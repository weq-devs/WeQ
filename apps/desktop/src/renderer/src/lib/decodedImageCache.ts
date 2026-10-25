import { readFrameBytes } from './frameImageSize';
import { MAX_DECORATION_FRAME_BYTES } from '../../../shared/decoration_image';

export const DECORATION_DECODE_LIMITS = {
  maxBytes: MAX_DECORATION_FRAME_BYTES,
  maxImages: 256,
  maxConcurrent: 4,
  maxPending: 512,
  timeoutMs: 15_000,
} as const;

type FrameImage = Pick<
  HTMLImageElement,
  'src' | 'naturalWidth' | 'naturalHeight' | 'decode' | 'removeAttribute'
>;
type Limits = { [K in keyof typeof DECORATION_DECODE_LIMITS]: number };
export interface PinOwner {
  pin(urls: readonly string[]): void;
  release(): void;
}
export class DecodeCapacityError extends Error {}
const cancelled = () => new DOMException('装扮预热已取消', 'AbortError');

/** 字节预算包含在途解码预留；已在播的帧不淘汰，新动画不得突破总预算。 */
export function createDecodedImageCache(
  limits: Limits = DECORATION_DECODE_LIMITS,
  createImage: () => FrameImage = () => new Image(),
) {
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new RangeError('预解码缓存限制必须为正整数');
  const retained = new Map<string, { image: FrameImage; bytes: number }>();
  const pinned = new Map<string, number>();
  type Job = {
    url: string;
    optional: boolean;
    users: Set<symbol>;
    controller: AbortController;
    promise: Promise<void>;
    optionalPromise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
  };
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  let retainedBytes = 0,
    reservedBytes = 0,
    reservedImages = 0,
    active = 0,
    cancelledJobs = 0;
  let disposed = false;
  const remove = (url: string) => {
    const entry = retained.get(url);
    if (!entry) return;
    retained.delete(url);
    retainedBytes -= entry.bytes;
    entry.image.removeAttribute('src');
  };
  const evict = () => {
    for (const url of retained.keys()) {
      if (pinned.has(url)) continue;
      remove(url);
      return true;
    }
    return false;
  };
  const load = async (job: Job) => {
    const image = createImage();
    let bytes = 0,
      reserved = false,
      kept = false;
    const { signal } = job.controller;
    const timer = setTimeout(() => job.controller.abort(), limits.timeoutMs);
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        (async () => {
          // 已有固有尺寸时复用；真实新 Image 的尺寸为 0，先读有界 PNG 头。
          bytes =
            image.naturalWidth > 0 && image.naturalHeight > 0
              ? image.naturalWidth * image.naturalHeight * 4
              : await readFrameBytes(job.url, signal);
          if (signal.aborted || disposed) throw cancelled();
          if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limits.maxBytes)
            throw new DecodeCapacityError('装扮帧超过解码预算');
          while (
            retainedBytes + reservedBytes + bytes > limits.maxBytes ||
            retained.size + reservedImages >= limits.maxImages
          ) {
            if (!evict()) throw new DecodeCapacityError('在播装扮已占满解码预算');
          }
          reservedBytes += bytes;
          reservedImages++;
          reserved = true;
          image.src = job.url;
          await image.decode();
          if (signal.aborted || disposed) throw cancelled();
          const actual = image.naturalWidth * image.naturalHeight * 4;
          if (!Number.isSafeInteger(actual) || actual <= 0 || actual > bytes)
            throw new Error('装扮帧尺寸与预检不一致');
          reservedBytes -= bytes;
          reservedImages--;
          reserved = false;
          retained.set(job.url, { image, bytes });
          retainedBytes += bytes;
          kept = true;
        })(),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(cancelled());
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
      if (reserved) {
        reservedBytes -= bytes;
        reservedImages--;
      }
      if (!kept) image.removeAttribute('src');
    }
  };
  const pump = () => {
    while (!disposed && active < limits.maxConcurrent && queue.length) {
      const job = queue.shift()!;
      active++;
      const settle = (error?: unknown) => {
        if (jobs.get(job.url) === job) jobs.delete(job.url);
        active--;
        if (error !== undefined) job.reject(error);
        else job.resolve();
        pump();
      };
      void load(job).then(() => settle(), settle);
    }
  };
  const enqueue = (url: string, optional: boolean): Job | null => {
    const existing = jobs.get(url);
    if (existing && !existing.controller.signal.aborted) {
      if (optional) existing.optional = true;
      return existing;
    }
    if (queue.length >= limits.maxPending) return null;
    let resolve = () => {},
      reject: (error: unknown) => void = () => {};
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const job: Job = {
      url,
      optional,
      users: new Set(),
      controller: new AbortController(),
      promise,
      optionalPromise: promise.catch(() => {}),
      resolve,
      reject,
    };
    jobs.set(url, job);
    queue.push(job);
    pump();
    return job;
  };
  const hit = (url: string) => {
    const entry = retained.get(url);
    if (!entry) return false;
    retained.delete(url);
    retained.set(url, entry);
    return true;
  };
  const stopUnused = (job: Job) => {
    if (job.users.size || job.optional || job.controller.signal.aborted) return;
    cancelledJobs++;
    job.controller.abort();
    const index = queue.indexOf(job);
    if (index >= 0) {
      queue.splice(index, 1);
      if (jobs.get(job.url) === job) jobs.delete(job.url);
      job.reject(cancelled());
    }
  };
  return {
    preload(url: string): Promise<void> {
      if (disposed || hit(url)) return Promise.resolve();
      return enqueue(url, true)?.optionalPromise ?? Promise.resolve();
    },
    require(url: string, signal?: AbortSignal): Promise<void> {
      if (disposed || signal?.aborted) return Promise.reject(cancelled());
      if (hit(url)) return Promise.resolve();
      const job = enqueue(url, false);
      if (!job) return Promise.reject(new DecodeCapacityError('装扮预热队列已满'));
      const token = Symbol();
      job.users.add(token);
      return new Promise<void>((resolve, reject) => {
        const abort = () => {
          cleanup();
          stopUnused(job);
          reject(cancelled());
        };
        const cleanup = () => {
          job.users.delete(token);
          signal?.removeEventListener('abort', abort);
        };
        signal?.addEventListener('abort', abort, { once: true });
        void job.promise.then(
          () => {
            cleanup();
            resolve();
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
        if (signal?.aborted) abort();
      });
    },
    pin(urls: readonly string[]): PinOwner {
      const owned = new Set<string>();
      let released = false;
      const add = (values: readonly string[]) => {
        if (released || disposed) return;
        for (const url of values) {
          if (owned.has(url)) continue;
          owned.add(url);
          pinned.set(url, (pinned.get(url) ?? 0) + 1);
        }
      };
      add(urls);
      return {
        pin: add,
        release() {
          if (released) return;
          released = true;
          for (const url of owned) {
            const count = (pinned.get(url) ?? 0) - 1;
            if (count > 0) pinned.set(url, count);
            else {
              pinned.delete(url);
              remove(url);
            }
          }
          owned.clear();
        },
      };
    },
    stats() {
      let pinnedImages = 0;
      for (const url of retained.keys()) if (pinned.has(url)) pinnedImages++;
      return {
        retainedImages: retained.size,
        retainedBytes,
        pinnedImages,
        reservedBytes,
        activeDecodes: active,
        pendingImages: queue.length,
        totalPendingImages: active + queue.length,
        cancelledJobs,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const job of jobs.values()) job.controller.abort();
      for (const job of queue.splice(0)) {
        jobs.delete(job.url);
        job.reject(cancelled());
      }
      for (const url of retained.keys()) remove(url);
      pinned.clear();
    },
  };
}

export const decorationImageCache = createDecodedImageCache();
