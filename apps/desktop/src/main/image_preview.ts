import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const PREVIEW_MAX_SIDE = 512;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

/** 在读取原图前排队；缓存按内容共享，不能用 CSS 缩放代替像素限制。 */
export function createImagePreviewer(options: { maxPending?: number; maxPixels?: number } = {}) {
  const waiting: (() => void)[] = [];
  const cache = new Map<string, Buffer>();
  let cacheBytes = 0;
  let active = false;
  return async (load: () => Promise<Uint8Array>): Promise<Buffer> => {
    if (active) {
      if (waiting.length >= (options.maxPending ?? 128)) throw new Error('preview capacity');
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else active = true;
    try {
      const input = await load();
      if (input.byteLength === 0 || input.byteLength > MAX_INPUT_BYTES)
        throw new Error('preview input size');
      const key = createHash('sha256').update(input).digest('hex');
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const output = await sharp(input, {
        limitInputPixels: options.maxPixels ?? 32 * 1024 * 1024,
        sequentialRead: true,
        animated: false,
      })
        .rotate()
        .resize({
          width: PREVIEW_MAX_SIDE,
          height: PREVIEW_MAX_SIDE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer();
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
      const next = waiting.shift();
      if (next) next();
      else active = false;
    }
  };
}

export const imagePreview = createImagePreviewer();
