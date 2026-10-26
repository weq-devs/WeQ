import {
  DEFAULT_CHAT_IMAGE_CACHE_MIB,
  normalizeChatImageCacheMiB,
} from '@weq/service/chat-image-cache';

type Preview = Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>;
const MAX_RETAINED_IMAGES = 512;

/** 持有已加载节点以跨虚拟列表卸载保留资源；只淘汰离屏项，不强制清空可见图片。 */
export function createChatImageCache(initialMiB = DEFAULT_CHAT_IMAGE_CACHE_MIB) {
  const entries = new Map<string, { image: Preview; bytes: number }>();
  const visible = new Map<string, number>();
  const listeners = new Set<() => void>();
  let limit = normalizeChatImageCacheMiB(initialMiB) * 1024 * 1024;
  let bytes = 0;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const touch = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    entries.set(key, entry);
  };
  const trim = () => {
    for (const [key, entry] of entries) {
      if (bytes <= limit && entries.size <= MAX_RETAINED_IMAGES) break;
      if (limit > 0 && visible.has(key)) continue;
      entries.delete(key);
      bytes -= entry.bytes;
    }
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    has(key: string) {
      return entries.has(key);
    },
    activate(key: string) {
      visible.set(key, (visible.get(key) ?? 0) + 1);
      touch(key);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (visible.get(key) ?? 1) - 1;
        if (count) visible.set(key, count);
        else visible.delete(key);
        trim();
        notify();
      };
    },
    remember(key: string, image: Preview) {
      const size = image.naturalWidth * image.naturalHeight * 4;
      if (!limit || !Number.isSafeInteger(size) || size <= 0 || size > limit) return;
      bytes -= entries.get(key)?.bytes ?? 0;
      entries.delete(key);
      entries.set(key, { image, bytes: size });
      bytes += size;
      trim();
      notify();
    },
    setBudgetMiB(value: number) {
      limit = normalizeChatImageCacheMiB(value) * 1024 * 1024;
      trim();
      notify();
    },
    clear() {
      entries.clear();
      bytes = 0;
      notify();
    },
    stats() {
      return { images: entries.size, bytes, limit };
    },
  };
}

export type ChatImageCache = ReturnType<typeof createChatImageCache>;
