import {
  DEFAULT_CHAT_IMAGE_CACHE_MIB,
  normalizeChatImageCacheMiB,
} from '@weq/service/chat-image-cache';

type Preview = Pick<
  HTMLImageElement,
  'naturalWidth' | 'naturalHeight' | 'ownerDocument' | 'currentSrc' | 'src'
>;
const MAX_RETAINED_IMAGES = 512;

export function createChatImageUrl(blob: Blob) {
  const src = URL.createObjectURL(blob);
  let references = 0;
  return {
    src,
    bytes: blob.size,
    retain() {
      references++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--references === 0) URL.revokeObjectURL(src);
      };
    },
  };
}

type ChatImageUrl = ReturnType<typeof createChatImageUrl>;
type Entry = { image: HTMLImageElement; bytes: number; asset?: ChatImageUrl; release?: () => void };
function discard(entry: Entry) {
  entry.image.removeAttribute('src');
  entry.release?.();
}

/** 独立图片保留解码资源，不持有 React 挂载节点与其组件树；只淘汰离屏项。 */
export function createChatImageCache(initialMiB = DEFAULT_CHAT_IMAGE_CACHE_MIB) {
  const entries = new Map<string, Entry>();
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
      discard(entry);
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
    source(key: string) {
      return entries.get(key)?.image.src;
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
    remember(key: string, image: Preview, direct?: ChatImageUrl) {
      const source = image.currentSrc || image.src;
      const previous = entries.get(key);
      const asset =
        direct?.src === source
          ? direct
          : previous?.asset?.src === source
            ? previous.asset
            : undefined;
      const size =
        image.naturalWidth * image.naturalHeight * 4 +
        (asset?.bytes ?? (source.startsWith('data:') ? source.length * 2 : 0));
      if (!limit || !Number.isSafeInteger(size) || size <= 0 || size > limit) return;
      if (previous?.bytes === size && previous.image.src === source) {
        touch(key);
        return;
      }
      // React 节点带有 Fiber/事件闭包；保留同源独立节点即可复用浏览器图片资源。
      const retained = image.ownerDocument.createElement('img');
      retained.src = source;
      const release = asset?.retain();
      if (previous) discard(previous);
      bytes -= previous?.bytes ?? 0;
      entries.delete(key);
      entries.set(key, { image: retained, bytes: size, asset, release });
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
      for (const entry of entries.values()) discard(entry);
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
