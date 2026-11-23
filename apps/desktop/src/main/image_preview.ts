import { createHash } from 'node:crypto';
import { imageThumbnail } from './image_processor';

export { PREVIEW_MAX_SIDE } from './image_processor';
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

/** 在读取原图前排队；缓存按内容共享，不能用 CSS 缩放代替像素限制。 */
export function createImagePreviewer(
  options: { maxPending?: number; maxPixels?: number; preserveAnimation?: boolean } = {},
) {
  const waiting = new Set<() => void>();
  const cache = new Map<string, Buffer>();
  let cacheBytes = 0;
  let active = false;
  return async (load: () => Promise<Uint8Array>, signal?: AbortSignal): Promise<Buffer> => {
    signal?.throwIfAborted();
    if (active) {
      if (waiting.size >= (options.maxPending ?? 128)) throw new Error('preview capacity');
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          waiting.delete(start);
          reject(signal?.reason);
        };
        const start = () => {
          waiting.delete(start);
          signal?.removeEventListener('abort', cancel);
          resolve();
        };
        waiting.add(start);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    } else active = true;
    try {
      signal?.throwIfAborted();
      const input = await load();
      signal?.throwIfAborted();
      if (input.byteLength === 0 || input.byteLength > MAX_INPUT_BYTES)
        throw new Error('preview input size');
      const key = createHash('sha256').update(input).digest('hex');
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const output = await imageThumbnail(
        input,
        options.maxPixels ?? 32 * 1024 * 1024,
        options.preserveAnimation ?? false,
      );
      while (cache.size >= 64 || cacheBytes + output.byteLength > MAX_CACHE_BYTES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cacheBytes -= cache.get(oldest)?.byteLength ?? 0;
        cache.delete(oldest);
      }
      if (output.byteLength <= MAX_CACHE_BYTES) {
        cache.set(key, output);
        cacheBytes += output.byteLength;
      }
      return output;
    } finally {
      const next = waiting.values().next().value;
      if (next) next();
      else active = false;
    }
  };
}

export const imagePreview = createImagePreviewer();
