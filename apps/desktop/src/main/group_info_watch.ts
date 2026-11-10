import type { DbWatchService, DbChange } from '@weq/service';

/** 群资料变化独立通知，不触发消息窗口重读或新消息提示。 */
export function mountGroupInfoWatch(
  watcher: Pick<DbWatchService, 'mount'>,
  dbPath: string,
  isCurrent: () => boolean,
  notify: (change: DbChange) => void,
) {
  let mounted = true;
  const handle = watcher.mount({
    dbPath,
    onDbFileChangeHook(change) {
      if (mounted && isCurrent()) notify(change);
    },
  });
  return {
    unmount() {
      mounted = false;
      handle.unmount();
    },
  };
}
