import type { DbChange, DbWatchTask } from '@weq/service';

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
