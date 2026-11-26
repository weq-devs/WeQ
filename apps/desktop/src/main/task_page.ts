import { randomUUID } from 'node:crypto';
import { observable } from '@trpc/server/observable';

const pages = new Set<string>();
const tasks = new Map<string, { pageId: string; handOff: () => void }>();

/** 订阅随页面、桌面窗口或 Web 连接关闭而释放。 */
export function watchTaskPage() {
  return observable<string>((emit) => {
    const id = randomUUID();
    pages.add(id);
    emit.next(id);
    return () => {
      pages.delete(id);
      for (const [key, task] of tasks) {
        if (task.pageId !== id) continue;
        tasks.delete(key);
        task.handOff();
      }
    };
  });
}

export function holdTaskOnPage(pageId: string | undefined, key: string, handOff: () => void) {
  if (!pageId || !pages.has(pageId)) return false;
  tasks.set(key, { pageId, handOff });
  return true;
}

export function forgetTaskOnPage(key: string) {
  tasks.delete(key);
}
