import { createHash } from 'node:crypto';
import type { DbWatchService } from '@weq/service';
import type { ContactNoticeKind } from '../shared/contact_notices';

interface ContactNoticeSource {
  kind: ContactNoticeKind;
  dbPath: string;
  read: () => Promise<readonly unknown[]>;
}

/** 文件事件只提示重新比较小表，不把在线状态、群成员等无关写入当作通知。 */
export function mountContactNoticeWatch(
  watcher: Pick<DbWatchService, 'mount'>,
  source: ContactNoticeSource,
  isCurrent: () => boolean,
  notify: (kind: ContactNoticeKind) => void,
) {
  let mounted = true;
  let running = false;
  let pending = false;
  let signature: string | undefined;
  let lastRead = Number.NEGATIVE_INFINITY;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => mounted && isCurrent();
  const schedule = () => {
    if (!active() || running || timer !== undefined) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void read();
      },
      failures
        ? Math.min(1000 * 2 ** (failures - 1), 30_000)
        : Math.max(100, lastRead + 1000 - Date.now()),
    );
    timer.unref?.();
  };
  async function read() {
    if (!active()) return;
    running = true;
    pending = false;
    lastRead = Date.now();
    try {
      const rows = await source.read();
      if (!active()) return;
      // 同时间记录的 SQL 顺序可变；比较内容集合，保留 bigint 的精确值。
      const contents = rows
        .map((row) =>
          JSON.stringify(row, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        )
        .sort();
      const next = createHash('sha256').update(JSON.stringify(contents)).digest('hex');
      failures = 0;
      if (next !== signature) {
        signature = next;
        // 首次快照也同步一次，覆盖启动查询与建立监听之间的写入。
        notify(source.kind);
      }
    } catch (error) {
      if (!active()) return;
      failures = Math.min(failures + 1, 6);
      if (failures === 1) console.error(`[contact-notice] ${source.kind} 通知读取失败`, error);
      pending = true;
    } finally {
      running = false;
      if (pending) schedule();
    }
  }
  const handle = watcher.mount({
    dbPath: source.dbPath,
    onDbFileChangeHook() {
      if (!active()) return;
      pending = true;
      schedule();
    },
  });
  void read();
  return {
    unmount() {
      if (!mounted) return;
      mounted = false;
      if (timer !== undefined) clearTimeout(timer);
      handle.unmount();
    },
  };
}
