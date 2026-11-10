import { unreadChatType } from '@weq/codec';

/** 精确计数逐会话排除自己发言，小批回显，水位快查仍可一次读取 256 项。 */
export const UNREAD_COUNT_BATCH_SIZE = 16;
export const UNREAD_WATERMARK_BATCH_SIZE = 256;
const UNREAD_RECONCILE_MS = 60_000;

interface CountWatermark {
  chatType: number;
  uid: string;
  msgSeq?: string;
  latestSeq: string | null;
  readError?: boolean;
  countPending?: boolean;
  highlights?: readonly object[];
}

/** 水位和阅读操作即时校准；无关库写入不触发全体历史重扫，同水位修正低频补齐。 */
export function createUnreadCountCache() {
  const completed = new Map<
    string,
    {
      msgSeq?: string;
      latestSeq: string | null;
      highlights?: readonly object[];
      databaseRevision: number;
      readRevision: number;
      at: number;
    }
  >();
  const key = (row: Pick<CountWatermark, 'chatType' | 'uid'>) => `${row.chatType}:${row.uid}`;
  const reconciliationDue = (last: { databaseRevision: number; at: number }, revision: number) =>
    last.databaseRevision !== revision && Date.now() - last.at >= UNREAD_RECONCILE_MS;
  return {
    retain(targets: readonly Pick<CountWatermark, 'chatType' | 'uid'>[]) {
      const active = new Set(targets.map(key));
      for (const id of completed.keys()) if (!active.has(id)) completed.delete(id);
    },
    needsReconcile(databaseRevision: number) {
      for (const last of completed.values())
        if (reconciliationDue(last, databaseRevision)) return true;
      return false;
    },
    remember(row: CountWatermark, databaseRevision: number, readRevision: number) {
      if (row.readError || row.countPending) return;
      completed.set(key(row), {
        msgSeq: row.msgSeq,
        latestSeq: row.latestSeq,
        highlights: row.highlights,
        databaseRevision,
        readRevision,
        at: Date.now(),
      });
    },
    needsCount(
      row: CountWatermark,
      databaseRevision: number,
      accepts: (uid: string, revision: number) => boolean,
    ) {
      const last = completed.get(key(row));
      return (
        !last ||
        reconciliationDue(last, databaseRevision) ||
        last.msgSeq !== row.msgSeq ||
        last.latestSeq !== row.latestSeq ||
        !sameUnreadHighlights(last.highlights, row.highlights) ||
        !accepts(row.uid, last.readRevision)
      );
    },
  };
}

/** QQ 已读变化没有新消息通知；仅优先校准仍有红点或高亮的会话。 */
export function unreadBadgeTargets(
  contacts: ReadonlyArray<{ chatType: number | string; targetUid: string }>,
  counts: Readonly<Record<string, number>>,
  highlights: Readonly<Record<string, readonly unknown[]>>,
): Array<{ chatType: NonNullable<ReturnType<typeof unreadChatType>>; uid: string }> {
  return contacts.flatMap((contact) => {
    if (!((counts[contact.targetUid] ?? 0) > 0) && !highlights[contact.targetUid]?.length)
      return [];
    const chatType = unreadChatType(contact.chatType);
    return chatType === null ? [] : [{ chatType, uid: contact.targetUid }];
  });
}

/** 合并数据库通知；执行中只补一轮，失败退避，销毁后不再启动查询。 */
export function createUnreadRefresh(load: () => Promise<boolean>, delayMs = 100) {
  let disposed = false;
  let running = false;
  let pending = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (delay: number) => {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
  };

  async function run() {
    if (disposed) return;
    running = true;
    pending = false;
    let succeeded = false;
    try {
      succeeded = await load();
    } catch {
      // 调用方保留旧状态；没有后续文件变化时也必须自行重试。
    } finally {
      running = false;
      failures = succeeded ? 0 : Math.min(failures + 1, 6);
      if (!disposed && (!succeeded || pending)) {
        arm(succeeded ? delayMs : Math.min(1000 * 2 ** (failures - 1), 30000));
      }
    }
  }

  return {
    request() {
      if (disposed) return;
      pending = true;
      if (!running) arm(failures > 0 ? Math.min(1000 * 2 ** (failures - 1), 30000) : delayMs);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** 实时变更只读受影响的会话，不排在全量扫描或首屏消息加载后面。 */
export function createUnreadTargetRefresh<T extends { chatType: number; uid: string }>(
  load: (targets: T[]) => Promise<boolean | T[]>,
  onOverflow?: () => void,
  batchSize = 256,
  minimumIntervalMs = 0,
) {
  let disposed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queued = new Map<string, { target: T; failures: number; at: number }>();
  const inFlight = new Set<string>();
  const completedAt = new Map<string, number>();
  const key = (target: T) => `${target.chatType}:${target.uid}`;
  const arm = () => {
    if (disposed || running || !queued.size) return;
    if (timer !== undefined) clearTimeout(timer);
    const due = Math.min(...[...queued.values()].map((entry) => entry.at));
    timer = setTimeout(
      () => {
        timer = undefined;
        void run();
      },
      Math.max(0, due - Date.now()),
    );
  };
  async function run() {
    if (disposed) return;
    const batch = [...queued.values()]
      .filter((entry) => entry.at <= Date.now())
      .slice(0, batchSize);
    if (!batch.length) {
      arm();
      return;
    }
    running = true;
    for (const entry of batch) {
      queued.delete(key(entry.target));
      inFlight.add(key(entry.target));
    }
    let failed = new Set(batch.map((entry) => key(entry.target)));
    try {
      const result = await load(batch.map((entry) => entry.target));
      if (result === true) failed.clear();
      else if (Array.isArray(result)) failed = new Set(result.map(key));
    } catch {
      // 只退避本批目标，期间排队的健康目标仍立即执行。
    } finally {
      running = false;
      inFlight.clear();
      if (!disposed) {
        for (const entry of batch) {
          const id = key(entry.target);
          if (!failed.has(id)) {
            if (minimumIntervalMs > 0) {
              completedAt.delete(id);
              if (completedAt.size >= 8192) completedAt.delete(completedAt.keys().next().value!);
              completedAt.set(id, Date.now());
              const next = queued.get(id);
              if (next) next.at = Math.max(next.at, Date.now() + minimumIntervalMs);
            }
            continue;
          }
          const failures = Math.min(6, entry.failures + 1);
          queued.set(key(entry.target), {
            target: queued.get(key(entry.target))?.target ?? entry.target,
            failures,
            at: Date.now() + Math.min(1000 * 2 ** (failures - 1), 30000),
          });
        }
        arm();
      }
    }
  }
  return {
    request(targets: T[], repeatInFlight = true) {
      if (disposed) return;
      for (const target of targets) {
        // 轮询只检查尚未读取的目标；定向变更仍保留执行中的下一轮。
        if (!repeatInFlight && inFlight.has(key(target))) continue;
        const existing = queued.get(key(target));
        if (!existing && queued.size >= 8192) {
          if (!onOverflow) throw new Error('未读目标队列已满，需要全量校准');
          onOverflow();
          continue;
        }
        queued.set(
          key(target),
          existing
            ? { ...existing, target }
            : {
                target,
                failures: 0,
                at: completedAt.has(key(target))
                  ? completedAt.get(key(target))! + minimumIntervalMs
                  : 0,
              },
        );
      }
      arm();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      queued.clear();
      completedAt.clear();
    },
  };
}

/** 只比较当前行的提醒字段，不序列化整个会话目录。 */
export function sameUnreadHighlights<T extends object>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): boolean {
  if (left === right) return true;
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every((value, index) => {
    const other = right?.[index];
    return (
      other !== undefined &&
      Object.keys(value).length === Object.keys(other).length &&
      (Object.keys(value) as Array<keyof T>).every((key) => value[key] === other[key])
    );
  });
}

/** 重试固定水位的已读请求；换号、换会话或隐藏后不再发出下一次请求。 */
export async function retryConversationRead<T>(
  write: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isCurrent()) return null;
    try {
      return await write();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 150 : 450));
    }
  }
  return null;
}
/** 写入期间忽略旧扫描，写入结束再次推进版本，隔离期间启动的扫描。 */
export function createUnreadUpdateGuard() {
  let revision = 0;
  const changed = new Map<string, number>();
  const pending = new Map<string, number>();
  return {
    revision: () => revision,
    begin(ids: string[]) {
      revision++;
      for (const id of ids) {
        changed.set(id, revision);
        pending.set(id, (pending.get(id) ?? 0) + 1);
      }
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        revision++;
        for (const id of ids) {
          changed.set(id, revision);
          const count = (pending.get(id) ?? 1) - 1;
          if (count) pending.set(id, count);
          else pending.delete(id);
        }
      };
    },
    accepts(id: string, startedAt: number) {
      return !pending.has(id) && (changed.get(id) ?? 0) <= startedAt;
    },
  };
}
