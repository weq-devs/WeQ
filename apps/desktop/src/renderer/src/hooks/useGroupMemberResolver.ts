/**
 * 统一的群成员（群名片）内存缓存 / 解析器。
 *
 * 群里发言人 / 灰条提示引用的 uid 可能落在「已加载的成员分页」之外。这个 hook
 * 负责按需批量补全这些离屏成员的群名片，结果按 groupCode → uid 两级缓存，确保 A
 * 群的名片绝不会泄漏到 B 群。
 *
 * 注意：群名片是「群 × uid」维度的（显示时 card 优先于 nick），与全局 profile
 * 缓存是两回事，所以独立成另一份缓存，只是复用同样的「去重 + 批量 + 回填」套路。
 * 与 useProfileResolver 同理，缓存活在 MainView 生命周期内，切号随重挂清空。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from '../trpc/client';

/** getGroupMembersByUids 的单次 uid 上限（与 IPC 层一致）。 */
const CHUNK = 200;
/** 列表预览不随每次群资料库写入全量重查；当前聊天使用即时刷新。 */
export const GROUP_MEMBER_PREVIEW_REFRESH_MS = 60_000;

interface MemberJob {
  groupCode: string;
  uids: string[];
  captured: Map<string, number>;
  generation: number;
  isCurrent: () => boolean;
  attempted: Set<string>;
}

export interface GroupMemberResolver<T> {
  /** groupCode → (uid → 离屏补全的成员)。 */
  missingMembers: Record<string, Record<string, T>>;
  /**
   * 补全某群里这批 uid 的成员卡片。已在 known（已加载分页）/ 已尝试过的 uid 会被
   * 跳过，其余批量 getGroupMembersByUids 后回填。`isCurrent` 在回填前再确认目标群
   * 仍是当前会话，切走则丢弃结果。重复调用不会对同一 uid 重复请求。
   */
  resolveMembers: (
    groupCode: string,
    uids: Iterable<string>,
    known: ReadonlySet<string>,
    isCurrent: () => boolean,
  ) => void;
  updateMembers: (groupCode: string, members: readonly T[]) => void;
  /** 合并旧排队任务并使查询记录失效；保留展示资料及预览刷新间隔。 */
  invalidate: () => void;
}

export function useGroupMemberResolver<T extends { uid: string }>(
  minRefreshIntervalMs = 0,
): GroupMemberResolver<T> {
  const [missingMembers, setMissingMembers] = useState<Record<string, Record<string, T>>>({});
  // 每个群已发起过 getGroupMembersByUids 的 uid（含查无结果的，例如已退群的戳一戳
  // / 禁言对象），避免每次渲染重复请求。用 ref 以便在同一轮内即时去重。
  const attemptedRef = useRef<Record<string, Set<string>>>({});
  const versions = useRef(new Map<string, number>());
  const generation = useRef(0);
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
  const invalidate = useCallback(() => {
    generation.current++;
    attemptedRef.current = {};
    versions.current.clear();
    jobs.current = [];
    cancelTimer();
  }, [cancelTimer]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      invalidate();
    };
  }, [invalidate]);
  const updateMembers = useCallback((groupCode: string, members: readonly T[]) => {
    for (const member of members) {
      const key = `${groupCode}:${member.uid}`;
      versions.current.set(key, (versions.current.get(key) ?? 0) + 1);
    }
    setMissingMembers((previous) => ({
      ...previous,
      [groupCode]: {
        ...previous[groupCode],
        ...Object.fromEntries(members.map((member) => [member.uid, member])),
      },
    }));
  }, []);

  const drain = useCallback(() => {
    if (!mounted.current || running.current) return;
    cancelTimer();
    jobs.current = jobs.current.filter((job) => {
      if (job.isCurrent()) return true;
      for (const uid of job.uids) job.attempted.delete(uid);
      return false;
    });
    const now = Date.now();
    let earliest = Infinity;
    const index = jobs.current.findIndex((job) => {
      const due = Math.min(
        ...job.uids.map((uid) => {
          const at = lastRead.current.get(`${job.groupCode}:${uid}`);
          return at === undefined ? 0 : at + minRefreshIntervalMs;
        }),
      );
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
    for (const uid of job.uids) {
      const at = lastRead.current.get(`${job.groupCode}:${uid}`);
      (at === undefined || at + minRefreshIntervalMs <= now ? ready : delayed).push(uid);
    }
    if (delayed.length) jobs.current.push({ ...job, uids: delayed });
    job.uids = ready;
    running.current = true;
    void (async () => {
      try {
        const members = await client.account.getGroupMembersByUids.query({
          groupCode: job.groupCode,
          uids: job.uids,
        });
        if (!mounted.current || job.generation !== generation.current) return;
        if (!job.isCurrent()) {
          for (const uid of job.uids) job.attempted.delete(uid);
          return;
        }
        // 只有接收过的结果才进入冷却；失效中的首次查询不能延迟新发言人首屏补全。
        for (const uid of job.uids) lastRead.current.set(`${job.groupCode}:${uid}`, Date.now());
        if (members.length > 0) {
          setMissingMembers((prev) => {
            if (job.generation !== generation.current) return prev;
            const groupCache = { ...(prev[job.groupCode] ?? {}) };
            for (const member of members as unknown as T[]) {
              if (
                job.captured.get(member.uid) ===
                (versions.current.get(`${job.groupCode}:${member.uid}`) ?? 0)
              )
                groupCache[member.uid] = member;
            }
            return { ...prev, [job.groupCode]: groupCache };
          });
        }
      } catch (err) {
        if (!mounted.current || job.generation !== generation.current) return;
        console.error('[group-members] getGroupMembersByUids failed', err);
        for (const uid of job.uids) job.attempted.delete(uid);
      } finally {
        running.current = false;
        drainRef.current();
      }
    })();
  }, [cancelTimer, minRefreshIntervalMs]);
  drainRef.current = drain;

  const resolveMembers = useCallback(
    (
      groupCode: string,
      uids: Iterable<string>,
      known: ReadonlySet<string>,
      isCurrent: () => boolean,
    ): void => {
      if (!groupCode || !mounted.current) return;
      let attempted = attemptedRef.current[groupCode];
      if (!attempted) {
        attempted = new Set();
        attemptedRef.current[groupCode] = attempted;
      }
      const missing: string[] = [];
      const captured = new Map<string, number>();
      for (const uid of uids) {
        if (!uid || known.has(uid) || attempted.has(uid)) continue;
        attempted.add(uid);
        missing.push(uid);
        captured.set(uid, versions.current.get(`${groupCode}:${uid}`) ?? 0);
      }
      if (missing.length === 0) return;
      for (let i = 0; i < missing.length; i += CHUNK)
        jobs.current.push({
          groupCode,
          uids: missing.slice(i, i + CHUNK),
          captured,
          generation: generation.current,
          isCurrent,
          attempted,
        });
      drainRef.current();
    },
    [],
  );

  return { missingMembers, resolveMembers, updateMembers, invalidate };
}
