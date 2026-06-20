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

import { useCallback, useRef, useState } from 'react';
import { client } from '../trpc/client';

/** getGroupMembersByUids 的单次 uid 上限（与 IPC 层一致）。 */
const CHUNK = 200;

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
}

export function useGroupMemberResolver<T extends { uid: string }>(): GroupMemberResolver<T> {
  const [missingMembers, setMissingMembers] = useState<Record<string, Record<string, T>>>({});
  // 每个群已发起过 getGroupMembersByUids 的 uid（含查无结果的，例如已退群的戳一戳
  // / 禁言对象），避免每次渲染重复请求。用 ref 以便在同一轮内即时去重。
  const attemptedRef = useRef<Record<string, Set<string>>>({});

  const resolveMembers = useCallback(
    (
      groupCode: string,
      uids: Iterable<string>,
      known: ReadonlySet<string>,
      isCurrent: () => boolean,
    ): void => {
      if (!groupCode) return;
      const attempted =
        attemptedRef.current[groupCode] ?? (attemptedRef.current[groupCode] = new Set());
      const missing: string[] = [];
      for (const uid of uids) {
        if (!uid || known.has(uid) || attempted.has(uid)) continue;
        attempted.add(uid);
        missing.push(uid);
      }
      if (missing.length === 0) return;

      void (async () => {
        for (let i = 0; i < missing.length; i += CHUNK) {
          const chunk = missing.slice(i, i + CHUNK);
          try {
            const members = await client.account.getGroupMembersByUids.query({
              groupCode,
              uids: chunk,
            });
            if (!isCurrent()) return;
            if (members.length > 0) {
              setMissingMembers((prev) => {
                const groupCache = { ...(prev[groupCode] ?? {}) };
                for (const member of members as unknown as T[]) groupCache[member.uid] = member;
                return { ...prev, [groupCode]: groupCache };
              });
            }
          } catch (err) {
            console.error('[group-members] getGroupMembersByUids failed', err);
            // 失败的 uid 放回，允许后续重试。
            for (const uid of chunk) attempted.delete(uid);
          }
        }
      })();
    },
    [],
  );

  return { missingMembers, resolveMembers };
}
