import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from '@weq/service/atomic-write';
import { isTaskArchived, type TaskArchive, type TaskArchiveEntry } from '../shared/task_archive';

export class TaskArchiveStore {
  readonly deleting = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private entries: TaskArchive | undefined;

  constructor(private readonly path: string) {}

  snapshot(): TaskArchive {
    if (!this.entries) {
      this.entries = existsSync(this.path)
        ? (JSON.parse(readFileSync(this.path, 'utf8')) as TaskArchive)
        : {};
    }
    return this.entries;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: Record<string, TaskArchiveEntry | null>) {
    if (!Object.keys(patch).length) return this.snapshot();
    const next = { ...this.snapshot() };
    for (const [id, entry] of Object.entries(patch)) {
      if (entry) next[id] = entry;
      else delete next[id];
    }
    writeFileAtomicSync(this.path, JSON.stringify(next));
    this.entries = next;
    for (const listener of this.listeners) listener();
    return next;
  }
}

const stores = new Map<string, TaskArchiveStore>();

export function taskArchiveStore(root: string, configId: string): TaskArchiveStore {
  const path = join(root, 'config', 'accounts', configId, 'task-archive.json');
  let store = stores.get(path);
  if (!store) {
    store = new TaskArchiveStore(path);
    stores.set(path, store);
  }
  return store;
}

/** 已打开产物，保留其业务记录；归档写入失败时仍可在当前任务查看。 */
export function archiveViewedTask(store: TaskArchiveStore, id: string, result: string) {
  try {
    const row = store.snapshot()[id];
    if (
      store.deleting.has(id) ||
      isTaskArchived(row, result) ||
      (row?.result === result && row.restored)
    )
      return;
    store.update({ [id]: { result, archivedAt: Date.now(), seen: true } });
  } catch {
    // 文件已打开，归档可从任务页重试。
  }
}
