export const DECORATION_DECODE_LIMITS = {
  maxBytes: 64 * 1024 * 1024,
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

/** 仅缓存装扮预热帧。RGBA 估算不等于整个浏览器／GPU 的实际占用。 */
export function createDecodedImageCache(
  limits: Limits = DECORATION_DECODE_LIMITS,
  createImage: () => FrameImage = () => new Image(),
) {
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new RangeError('预解码缓存限制必须为正整数');
  const retained = new Map<string, { image: FrameImage; bytes: number }>();
  const pending = new Map<string, Promise<void>>();
  const queue: { url: string; resolve(): void }[] = [];
  const controller = new AbortController();
  let retainedBytes = 0;
  let active = 0;
  let disposed = false;
  const release = (image: FrameImage) => image.removeAttribute('src');
  const evictOldest = () => {
    const first = retained.entries().next().value;
    if (!first) return;
    retained.delete(first[0]);
    retainedBytes -= first[1].bytes;
    release(first[1].image);
  };
  const load = async (url: string): Promise<void> => {
    let image: FrameImage | undefined;
    let kept = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      image = createImage();
      image.src = url;
      const decoded = await Promise.race([
        image.decode().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), limits.timeoutMs);
        }),
        new Promise<boolean>((resolve) => {
          abort = () => resolve(false);
          controller.signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
      if (!decoded || disposed) return;
      const bytes = image.naturalWidth * image.naturalHeight * 4;
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limits.maxBytes) return;
      while (retained.size >= limits.maxImages || retainedBytes + bytes > limits.maxBytes)
        evictOldest();
      retained.set(url, { image, bytes });
      retainedBytes += bytes;
      kept = true;
    } catch {
      // 预热失败不阻止现有 CSS 按需取图，也不保留失败对象。
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) controller.signal.removeEventListener('abort', abort);
      if (image && !kept) release(image);
    }
  };
  const pump = (): void => {
    while (!disposed && active < limits.maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      active++;
      void load(job.url).finally(() => {
        pending.delete(job.url);
        active--;
        job.resolve();
        pump();
      });
    }
  };
  return {
    preload(url: string): Promise<void> {
      if (disposed) return Promise.resolve();
      const cached = retained.get(url);
      if (cached) {
        retained.delete(url);
        retained.set(url, cached);
        return Promise.resolve();
      }
      const running = pending.get(url);
      if (running) return running;
      // 超出的只是可选预热，CSS 对该帧的正常读取不受影响。
      if (queue.length >= limits.maxPending) return Promise.resolve();
      const promise = new Promise<void>((resolve) => queue.push({ url, resolve }));
      pending.set(url, promise);
      pump();
      return promise;
    },
    stats() {
      return {
        retainedImages: retained.size,
        retainedBytes,
        activeDecodes: active,
        pendingImages: queue.length,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      for (const job of queue.splice(0)) {
        pending.delete(job.url);
        job.resolve();
      }
      while (retained.size > 0) evictOldest();
    },
  };
}

export const decorationImageCache = createDecodedImageCache();
