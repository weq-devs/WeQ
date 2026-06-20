/**
 * 统一的 profile 内存缓存 / 解析器。
 *
 * 把「按 uid 拿昵称 / 头像 / 备注」收敛成单一来源：listProfiles 的整批数据先
 * 预热，没覆盖到的 uid 通过 getProfilesByUids 批量补全，结果合并进同一个 Map。
 * 调用方只管 `resolveProfiles(uids)` —— 命中预热集与在途请求的 uid 都会被跳过，
 * 绝不对同一个 uid 重复发查询，因此可以放心地每次渲染都把整批 uid 传进来。
 *
 * 缓存活在调用组件（MainView）的生命周期内。MainView 以 openedUin 为 key，切号
 * 会整组件重挂、缓存随之清空，所以这里无需按账号手动清理。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { client } from '../trpc/client';

/** getProfilesByUids 的单次 uid 上限（与 IPC 层 account.getProfilesByUids 一致）。 */
const CHUNK = 200;

export interface ProfileResolver<T> {
  /** uid → profile（预热 + 按需补全合并后的只读视图）。 */
  profileByUid: Map<string, T>;
  /**
   * 确保给定 uid 的 profile 进入缓存。已在预热集 / 已补全 / 已在途的 uid 会被
   * 跳过，其余按 CHUNK 分块批量查询后回填。重复调用不会产生重复请求。
   */
  resolveProfiles: (uids: Iterable<string>) => void;
}

export function useProfileResolver<T extends { uid: string }>(
  primed: readonly T[] | undefined,
): ProfileResolver<T> {
  // listProfiles 没覆盖到、按需补全回来的 profile。
  const [resolved, setResolved] = useState<Record<string, T>>({});
  // 已发起过请求的 uid（含查无结果的），用于去重。用 ref 以便在同一轮
  // resolveProfiles 内即时生效，不必等 state 提交。
  const inFlightRef = useRef<Set<string>>(new Set());

  const primedMap = useMemo(() => {
    const map = new Map<string, T>();
    for (const profile of primed ?? []) map.set(profile.uid, profile);
    return map;
  }, [primed]);

  const profileByUid = useMemo(() => {
    const map = new Map(primedMap);
    // 补全结果覆盖预热值（与旧 missingNotifyProfiles 合并顺序保持一致）。
    for (const profile of Object.values(resolved)) map.set(profile.uid, profile);
    return map;
  }, [primedMap, resolved]);

  const resolveProfiles = useCallback(
    (uids: Iterable<string>): void => {
      const inFlight = inFlightRef.current;
      const missing: string[] = [];
      for (const uid of uids) {
        if (!uid || primedMap.has(uid) || inFlight.has(uid)) continue;
        inFlight.add(uid);
        missing.push(uid);
      }
      if (missing.length === 0) return;

      void (async () => {
        for (let i = 0; i < missing.length; i += CHUNK) {
          const chunk = missing.slice(i, i + CHUNK);
          try {
            const list = await client.account.getProfilesByUids.query({ uids: chunk });
            if (list.length > 0) {
              setResolved((prev) => {
                const next = { ...prev };
                for (const profile of list as unknown as T[]) next[profile.uid] = profile;
                return next;
              });
            }
          } catch (err) {
            console.error('[profiles] getProfilesByUids failed', err);
            // 失败的 uid 放回，允许后续重试。
            for (const uid of chunk) inFlight.delete(uid);
          }
        }
      })();
    },
    [primedMap],
  );

  return { profileByUid, resolveProfiles };
}
