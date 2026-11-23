import type { DbChange, DbWatchService, DbWatchTask } from '@weq/service';

/** A file event may include writes unrelated to the proxy push. Always reconcile the last observation. */
export function coalesceLiveDbWatch(task: DbWatchTask, hasRecentPush: () => boolean): DbWatchTask {
  let deferred: DbChange | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const file = deferred;
    deferred = undefined;
    if (file) return task.onDbFileChangeHook(file);
  };
  return {
    dbPath: task.dbPath,
    onDbFileChangeHook(file) {
      deferred = file;
      if (!hasRecentPush()) return flush();
      timer ??= setTimeout(() => {
        void Promise.resolve()
          .then(flush)
          .catch(() => undefined);
      }, 1200).unref();
    },
    dispose() {
      clearTimeout(timer);
      deferred = undefined;
      task.dispose?.();
    },
  };
}

/** Keep the UI reader on an observation another consumer is already reading.
 * Unknown UI changes can still reconcile on their own coalesced path. */
export function createLiveMessageObservers(watch: Pick<DbWatchService, 'mount'>) {
  const readers = new WeakMap<object, Set<() => boolean>>();
  return {
    consumer(session: object, canRead: () => boolean = () => true): Pick<DbWatchService, 'mount'> {
      return {
        mount(task) {
          const handle = watch.mount(task);
          const active = readers.get(session) ?? new Set();
          readers.set(session, active);
          const read = () => canRead();
          active.add(read);
          return {
            unmount() {
              active.delete(read);
              if (!active.size && readers.get(session) === active) readers.delete(session);
              handle.unmount();
            },
          };
        },
      };
    },
    hasConsumer(session: object): boolean {
      for (const canRead of readers.get(session) ?? []) if (canRead()) return true;
      return false;
    },
  };
}
