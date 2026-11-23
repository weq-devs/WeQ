/**
 * 统一的群成员（群名片）内存缓存 / 解析器。
 *
 * 群里发言人 / 灰条提示引用的 UID 或 QQ 号可能落在「已加载的成员分页」之外。这个 hook
 * 负责按需批量补全这些离屏成员的群名片，结果按 groupCode → uid 两级缓存，确保 A
 * 群的名片绝不会泄漏到 B 群。
 *
 * 注意：群名片是「群 × uid」维度的（显示时 card 优先于 nick），与全局 profile
 * 缓存是两回事，所以独立成另一份缓存，只是复用同样的「去重 + 批量 + 回填」套路。
 * 与 useProfileResolver 同理，缓存活在 MainView 生命周期内，切号随重挂清空。
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { client } from '../trpc/client';
import { createGroupMemberResults, type GroupMemberResults } from '../lib/groupMemberResults';
import { isMemberUin, type GroupMemberLookup } from '../lib/groupMemberRefresh';

/** getGroupMembersByUids 的单次 uid 上限（与 IPC 层一致）。 */
const CHUNK = 200;
/** 列表预览不随每次群资料库写入全量重查；当前聊天使用即时刷新。 */
export const GROUP_MEMBER_PREVIEW_REFRESH_MS = 60_000;

interface MemberJob {
  groupCode: string;
  identities: string[];
  captured: Map<string, number>;
  isCurrent: () => boolean;
  attempted: Set<string>;
  dueAt?: number;
  dueIntervalMs?: number;
}

export interface GroupMemberResolver<T> {
  /** groupCode → (uid → 离屏补全的成员)。 */
  missingMembers: Record<string, Record<string, T>>;
  /**
   * 补全某群中这批身份的成员卡片。跳过已知或已尝试过的 UID 或 QQ 号。
   * `isCurrent` 在回填前再确认目标群
   * 仍是当前会话，切走则丢弃结果。重复调用不会对同一 uid 重复请求。
   */
  resolveMembers: (
    groupCode: string,
    identities: Iterable<string>,
    known: ReadonlySet<string>,
    isCurrent: () => boolean,
  ) => void;
  updateMembers: (groupCode: string, members: readonly T[]) => void;
  /** 合并旧排队任务并使查询记录失效；保留展示资料及预览刷新间隔。 */
  invalidate: (groupCode?: string) => void;
}

export function useGroupMemberResolver<T extends { uid: string; uin?: string }>(
  minRefreshIntervalMs = 0,
  lookup?: GroupMemberLookup<T>,
  sharedResults?: GroupMemberResults<T>,
): GroupMemberResolver<T> {
  const results = useMemo(() => sharedResults ?? createGroupMemberResults<T>(), [sharedResults]);
  const missingMembers = useSyncExternalStore(results.subscribe, results.snapshot);
  // 每个群已发起过 getGroupMembersByUids 的 uid（含查无结果的，例如已退群的戳一戳
  // / 禁言对象），避免每次渲染重复请求。用 ref 以便在同一轮内即时去重。
  const attemptedRef = useRef<Record<string, Set<string>>>({});
  const versions = useRef(new Map<string, number>());
  const jobs = useRef<MemberJob[]>([]);
  const running = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastRead = useRef(new Map<string, number>());
  const drainRef = useRef<() => void>(() => {});
  const cancelTimer = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const invalidate = useCallback(
    (groupCode?: string) => {
      if (groupCode !== undefined) {
        delete attemptedRef.current[groupCode];
        jobs.current = jobs.current.filter((job) => job.groupCode !== groupCode);
        return;
      }
      attemptedRef.current = {};
      versions.current.clear();
      jobs.current = [];
      cancelTimer();
    },
    [cancelTimer],
  );
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = results.onEvict((group) => {
      invalidate(group);
      const prefix = `${group}:`;
      for (const key of versions.current.keys())
        if (key.startsWith(prefix)) versions.current.delete(key);
      for (const key of lastRead.current.keys())
        if (key.startsWith(prefix)) lastRead.current.delete(key);
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      invalidate();
    };
  }, [invalidate, results]);
  const updateMembers = useCallback(
    (groupCode: string, members: readonly T[]) => {
      results.touch(groupCode);
      for (const member of members) {
        const key = `${groupCode}:${member.uid}`;
        versions.current.set(key, (versions.current.get(key) ?? 0) + 1);
        if (member.uin && isMemberUin(member.uin)) {
          const numberKey = `${groupCode}:${member.uin}`;
          versions.current.set(numberKey, (versions.current.get(numberKey) ?? 0) + 1);
        }
      }
      results.merge(groupCode, members);
    },
    [results],
  );

  const drain = useCallback(() => {
    if (!mounted.current || running.current) return;
    cancelTimer();
    jobs.current = jobs.current.filter((job) => {
      if (job.isCurrent()) return true;
      for (const identity of job.identities) job.attempted.delete(identity);
      return false;
    });
    const now = Date.now();
    let earliest = Infinity;
    const index = jobs.current.findIndex((job) => {
      // 串行队列内 UID 去重；其他任务完成不会改变本任务的上次读取时间。
      if (job.dueAt === undefined || job.dueIntervalMs !== minRefreshIntervalMs) {
        job.dueAt =
          minRefreshIntervalMs > 0
            ? Math.min(
                ...job.identities.map((identity) => {
                  const at = lastRead.current.get(`${job.groupCode}:${identity}`);
                  return at === undefined ? 0 : at + minRefreshIntervalMs;
                }),
              )
            : 0;
        job.dueIntervalMs = minRefreshIntervalMs;
      }
      const due = job.dueAt;
      earliest = Math.min(earliest, due);
      return due <= now;
    });
    if (index < 0) {
      if (jobs.current.length)
        timer.current = setTimeout(() => drainRef.current(), Math.max(0, earliest - now));
      return;
    }
    const job = jobs.current.splice(index, 1)[0]!;
    const ready: string[] = [];
    const delayed: string[] = [];
    for (const identity of job.identities) {
      const at =
        minRefreshIntervalMs > 0 ? lastRead.current.get(`${job.groupCode}:${identity}`) : undefined;
      (at === undefined || at + minRefreshIntervalMs <= now ? ready : delayed).push(identity);
    }
    if (delayed.length) jobs.current.push({ ...job, identities: delayed, dueAt: undefined });
    const byUin = isMemberUin(ready[0]!);
    running.current = true;
    void (async () => {
      try {
        const members = await (lookup
          ? lookup({ groupCode: job.groupCode, identities: ready })
          : byUin
            ? client.account.getGroupMembersByUins.query({ groupCode: job.groupCode, uins: ready })
            : client.account.getGroupMembersByUids.query({
                groupCode: job.groupCode,
                uids: ready,
              }));
        if (!mounted.current || attemptedRef.current[job.groupCode] !== job.attempted) return;
        if (!job.isCurrent()) {
          for (const identity of ready) job.attempted.delete(identity);
          return;
        }
        if (minRefreshIntervalMs > 0) {
          // 只为已接收的预览结果保留冷却时间，按最近读取顺序清理过期记录。
          const readAt = Date.now();
          const reads = lastRead.current;
          for (const [key, at] of reads) {
            if (at + minRefreshIntervalMs > readAt) break;
            reads.delete(key);
          }
          for (const identity of ready) {
            const key = `${job.groupCode}:${identity}`;
            reads.delete(key);
            reads.set(key, readAt);
          }
        }
        if (members.length > 0) {
          results.merge(job.groupCode, members as unknown as T[], (member) => {
            const identity = byUin ? member.uin : member.uid;
            return (
              identity !== undefined &&
              job.captured.get(identity) ===
                (versions.current.get(`${job.groupCode}:${identity}`) ?? 0)
            );
          });
        }
      } catch (err) {
        if (!mounted.current || attemptedRef.current[job.groupCode] !== job.attempted) return;
        console.error('[group-members] group member lookup failed', err);
        for (const identity of ready) job.attempted.delete(identity);
      } finally {
        running.current = false;
        drainRef.current();
      }
    })();
  }, [cancelTimer, minRefreshIntervalMs, lookup, results]);
  drainRef.current = drain;

  const resolveMembers = useCallback(
    (
      groupCode: string,
      identities: Iterable<string>,
      known: ReadonlySet<string>,
      isCurrent: () => boolean,
    ): void => {
      if (!groupCode || !mounted.current) return;
      results.touch(groupCode);
      let attempted = attemptedRef.current[groupCode];
      if (!attempted) {
        attempted = new Set();
        attemptedRef.current[groupCode] = attempted;
      }
      const missingUids: string[] = [];
      const missingUins: string[] = [];
      const captured = new Map<string, number>();
      for (const identity of identities) {
        if (!identity || known.has(identity) || attempted.has(identity)) continue;
        attempted.add(identity);
        (isMemberUin(identity) ? missingUins : missingUids).push(identity);
        captured.set(identity, versions.current.get(`${groupCode}:${identity}`) ?? 0);
      }
      if (!captured.size) return;
      for (const missing of [missingUids, missingUins]) {
        for (let i = 0; i < missing.length; i += CHUNK)
          jobs.current.push({
            groupCode,
            identities: missing.slice(i, i + CHUNK),
            captured,
            isCurrent,
            attempted,
          });
      }
      drainRef.current();
    },
    [results],
  );

  return { missingMembers, resolveMembers, updateMembers, invalidate };
}
