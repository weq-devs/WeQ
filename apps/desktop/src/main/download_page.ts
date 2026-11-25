import { randomUUID } from 'node:crypto';
import { observable } from '@trpc/server/observable';

const pages = new Set<string>();
const downloads = new Map<string, { pageId: string; handOff: () => void }>();

/** 订阅随设置页、桌面窗口或 Web 连接关闭而释放。 */
export function watchDownloadPage() {
  return observable<string>((emit) => {
    const id = randomUUID();
    pages.add(id);
    emit.next(id);
    return () => {
      pages.delete(id);
      for (const [key, download] of downloads) {
        if (download.pageId !== id) continue;
        downloads.delete(key);
        download.handOff();
      }
    };
  });
}

export function holdDownloadOnPage(pageId: string | undefined, key: string, handOff: () => void) {
  if (!pageId || !pages.has(pageId)) return false;
  downloads.set(key, { pageId, handOff });
  return true;
}
