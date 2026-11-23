import type { DbWatchService, DbChange } from '@weq/service';
import { coalesceLiveDbWatch } from './qq_sync/live_db_watch';

export interface GroupInfoChange {
  at: number;
  groupCode?: string;
  directory?: boolean;
}

/** 群资料变化独立通知，不触发消息窗口重读或新消息提示。 */
export function mountGroupInfoWatch(
  watcher: Pick<DbWatchService, 'mount'>,
  dbPath: string,
  isCurrent: () => boolean,
  notify: (change: DbChange) => void,
  hasRecentGroupPush?: () => boolean,
) {
  let mounted = true;
  const task = {
    dbPath,
    onDbFileChangeHook(change: DbChange) {
      if (mounted && isCurrent()) notify(change);
    },
  };
  const handle = watcher.mount(
    hasRecentGroupPush ? coalesceLiveDbWatch(task, hasRecentGroupPush) : task,
  );
  return {
    unmount() {
      mounted = false;
      handle.unmount();
    },
  };
}
