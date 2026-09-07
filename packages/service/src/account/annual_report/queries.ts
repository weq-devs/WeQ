import type { AccountSession } from '@weq/account';
import {
  mergeDressTally,
  type C2cInitiationTally,
  type C2cPeerDayTally,
  type DressTally,
  type SentWeekdayHourlyGrid,
} from '@weq/db';
import type { DressNameResolver, ReportQueries } from './types';

/** 私聊 / 群聊两份 7×24 矩阵原位相加，缺行缺列按全零补齐。 */
function mergeWeekdayHourlyGrids(parts: SentWeekdayHourlyGrid[]): SentWeekdayHourlyGrid {
  const merged: SentWeekdayHourlyGrid = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0),
  );
  for (const part of parts) {
    if (!Array.isArray(part)) continue;
    for (let dow = 0; dow < 7; dow++) {
      const row = part[dow];
      if (!Array.isArray(row)) continue;
      for (let hour = 0; hour < 24; hour++) {
        const count = Number(row[hour] ?? 0);
        if (count > 0) merged[dow]![hour] = (merged[dow]![hour] ?? 0) + count;
      }
    }
  }
  return merged;
}

/**
 * Create the typed query capability passed to page compute / availability hooks.
 *
 * The surface is deliberately small and typed: pages get read-only, account-bound
 * queries and never touch `AccountSession`, a database handle or raw SQL.
 */
export function createReportQueries(
  session: AccountSession,
  options: {
    resolveDressNames?: DressNameResolver;
    resolveEmojiNames?: (faceIds: number[]) => Promise<Record<number, string>>;
  } = {},
): ReportQueries {
  // 自己的 uid 用 session 打开时已经驻留内存的 uidMap（nt_uid_mapping_table）
  // 反查，不在这里对 c2c 消息表做任何推断扫描。群聊方向计数按 uid 精确匹配
  // 40020，和 chat 里既有的 selfUid / 群活跃统计口径一致。
  const selfUin = BigInt(Number(session.context.uin) || 0);
  const selfUid = selfUin > 0n ? (session.uidMap.uidByUin(selfUin) ?? '') : '';

  type DirectionCounts = {
    c2cSent: number;
    c2cReceived: number;
    groupSent: number;
    groupReceived: number;
  };
  const countCache = new Map<string, Promise<DirectionCounts>>();
  const dressCache = new Map<string, Promise<DressTally>>();
  const dayTallyCache = new Map<string, Promise<C2cPeerDayTally[]>>();
  const initiationCache = new Map<string, Promise<C2cInitiationTally[]>>();
  const weekdayHourlyCache = new Map<string, Promise<SentWeekdayHourlyGrid>>();
  const speechCache = new Map<string, Promise<import('@weq/db').SentSpeechRow[]>>();
  const groupCountCache = new Map<
    string,
    Promise<
      Array<{
        groupCode: string;
        groupName: string;
        memberCount: number;
        sentCount: number;
        totalCount: number;
      }>
    >
  >();
  const groupSpeechCache = new Map<string, Promise<import('@weq/db').SentSpeechRow[]>>();
  const interactionCache = new Map<string, Promise<import('@weq/db').GroupInteractionTally>>();
  let oldestCache: Promise<number | null> | null = null;
  let sentYearsCache: Promise<number[]> | null = null;

  function oldestMessageTime(): Promise<number | null> {
    if (oldestCache) return oldestCache;
    oldestCache = Promise.all([
      session.c2cMsgs.oldestSendTime(),
      session.groupMsgs.oldestSendTime(),
    ])
      .then(([c2c, group]) => {
        const candidates = [c2c, group].filter((v): v is bigint => v != null && v > 0n);
        return candidates.length === 0
          ? null
          : Number(candidates.reduce((a, b) => (a < b ? a : b)));
      })
      .catch((error: unknown) => {
        oldestCache = null;
        throw error;
      });
    return oldestCache;
  }

  /**
   * 「发出过至少一条消息」的年份并集，升序去重。私聊按行内自证方向判定，群聊
   * 用与 countByDirection 同一个 self marker（uid 优先、uin 兜底）。
   */
  function sentYears(): Promise<number[]> {
    if (sentYearsCache) return sentYearsCache;
    sentYearsCache = Promise.all([
      session.c2cMsgs.sentYears(),
      session.groupMsgs.sentYears(
        selfUid ? { senderUid: selfUid } : selfUin > 0n ? { selfUin } : {},
      ),
    ])
      .then(([c2c, group]) => [...new Set([...c2c, ...group])].sort((a, b) => a - b))
      .catch((error: unknown) => {
        sentYearsCache = null;
        throw error;
      });
    return sentYearsCache;
  }

  return {
    overview: {
      /**
       * Sent / received split for one time window, one pass per table. Only
       * real private chats (c2c_msg_table) and group chats (group_msg_table)
       * are counted — dataline / service tables are never queried here.
       */
      async countByDirection(startTime: number, endTime: number) {
        const key = `${startTime}:${endTime}`;
        let running = countCache.get(key);
        if (!running) {
          running = Promise.all([
            // c2c 方向由行内数据自证（senderUid != targetUid），无需 uidMap。
            session.c2cMsgs.countByDirection({ startTime, endTime }),
            session.groupMsgs.countByDirection({
              startTime,
              endTime,
              ...(selfUid ? { senderUid: selfUid } : selfUin > 0n ? { selfUin } : {}),
            }),
          ]).then(([c2c, group]) => ({
            c2cSent: c2c.sent,
            c2cReceived: c2c.received,
            groupSent: group.sent,
            groupReceived: group.received,
          }));
          countCache.set(key, running);
          // 失败时清掉缓存，页面重试可以重新扫；成功结果保留供 availability/compute 复用。
          void running.catch(() => {
            countCache.delete(key);
          });
        }
        return running;
      },
    },
    dress: {
      /**
       * 装扮 tally（列 40801）。两张表各一次单列扫描后合并，与 countByDirection
       * 共用同一个 self marker（uid 优先、uin 兜底），口径因此和总览页一致。
       *
       * 与 countByDirection 同款的 per-window 记忆化：availability 探一次、compute
       * 再取一次，只扫一遍库。
       */
      async tally(startTime: number, endTime: number) {
        const key = `${startTime}:${endTime}`;
        let running = dressCache.get(key);
        if (!running) {
          running = Promise.all([
            session.c2cMsgs.tallyDress({ startTime, endTime }),
            session.groupMsgs.tallyDress({
              startTime,
              endTime,
              ...(selfUid ? { senderUid: selfUid } : selfUin > 0n ? { selfUin } : {}),
            }),
          ]).then(([c2c, group]) => mergeDressTally([c2c, group]));
          dressCache.set(key, running);
          void running.catch(() => {
            dressCache.delete(key);
          });
        }
        return running;
      },
      /** 宿主没注入解析器时一律返回空表 —— 渲染层会退回 `#itemId`。 */
      names(kind, itemIds) {
        if (!options.resolveDressNames || itemIds.length === 0) return {};
        try {
          return options.resolveDressNames(kind, itemIds);
        } catch {
          return {};
        }
      },
    },
    emoji: {
      /**
       * 批量解析系统表情的名字。宿主没注入解析器时返回空表 —— 页面回退到消息
       * 自带的 faceText（/捂脸 / [捂脸]），再兜底到「表情 N」。
       */
      async names(faceIds: number[]) {
        if (!options.resolveEmojiNames || faceIds.length === 0) return {};
        const unique = [...new Set(faceIds.filter((id) => id > 0))];
        if (unique.length === 0) return {};
        try {
          return await options.resolveEmojiNames(unique);
        } catch {
          return {};
        }
      },
    },
    speech: {
      /**
       * 我发出的消息正文（解码后）。一次窗口的扫描结果跨调用记忆化，避免同一个
       * 时间窗被 availability / compute 或多次重试重复扫两遍 —— 这是唯一一个要
       * 逐条解 40800 的查询面，能省一次就省一次。
       */
      async sentRows(startTime: number, endTime: number) {
        const key = `${startTime}:${endTime}`;
        let running = speechCache.get(key);
        if (!running) {
          running = Promise.all([
            session.c2cMsgs.sentSpeechRows({ startTime, endTime }),
            session.groupMsgs.sentSpeechRows({
              startTime,
              endTime,
              ...(selfUid ? { senderUid: selfUid } : selfUin > 0n ? { selfUin } : {}),
            }),
          ]).then(([c2c, group]) => [...c2c, ...group]);
          speechCache.set(key, running);
          void running.catch(() => {
            speechCache.delete(key);
          });
        }
        return running;
      },
    },
    group: {
      /**
       * 群聊排行：group_detail 的群元数据 ⋈ 一次按群×方向的轻扫描。availability
       * 与 compute 问同一个时间窗时共享同一次扫描，因此返回数组共享只读、按
       * 自己发言数降序，调用方不要原地修改。
       */
      async countRows(startTime: number, endTime: number) {
        const key = `${startTime}:${endTime}`;
        let running = groupCountCache.get(key);
        if (!running) {
          running = (async () => {
            const groups = await session.groupDetail.listAll(2000, 0);
            const codes = groups.map((group) => String(group.groupCode));
            if (codes.length === 0) return [];
            const rows = await session.groupMsgs.countByGroupAndDirection(codes, {
              startTime,
              endTime,
              ...(selfUid ? { senderUid: selfUid } : selfUin > 0n ? { selfUin } : {}),
            });
            const byCode = new Map(rows.map((row) => [row.groupCode, row]));
            return groups
              .map((group) => {
                const code = String(group.groupCode);
                const bucket = byCode.get(code);
                return {
                  groupCode: code,
                  groupName: group.groupName || code,
                  memberCount: group.memberCount,
                  sentCount: bucket?.sent ?? 0,
                  totalCount: bucket?.total ?? 0,
                };
              })
              .filter((row) => row.sentCount > 0)
              .sort(
                (a, b) =>
                  b.sentCount - a.sentCount ||
                  b.totalCount - a.totalCount ||
                  a.groupName.localeCompare(b.groupName, 'zh'),
              );
          })();
          groupCountCache.set(key, running);
          // 失败时清掉缓存，页面重试可以重新扫；成功结果保留供 availability / compute 复用。
          void running.catch(() => {
            groupCountCache.delete(key);
          });
        }
        return running;
      },
      /**
       * 冠军群的全体正文（解码后）。同群同窗口只扫一次，返回共享只读数组。
       */
      async speechRows(groupCode: string, startTime: number, endTime: number) {
        const key = `${groupCode}:${startTime}:${endTime}`;
        let running = groupSpeechCache.get(key);
        if (!running) {
          running = session.groupMsgs.bodyRowsInGroup(groupCode, { startTime, endTime });
          groupSpeechCache.set(key, running);
          void running.catch(() => {
            groupSpeechCache.delete(key);
          });
        }
        return running;
      },
      /**
       * 我在一个群里的成员身份 + 等级名。只给冠军群查一次；本地成员行 / 群元
       * 数据缺失时返回 null，页面优雅降级而不是编造一个假头衔。
       */
      async standing(groupCode: string) {
        const code = BigInt(groupCode);
        let member: import('@weq/db').GroupMember | null = null;
        try {
          if (selfUid) {
            const rows = await session.groupMembers.getMembersByUids(code, [selfUid]);
            member = rows[0] ?? null;
          }
          if (!member && selfUin > 0n) {
            const rows = await session.groupMembers.getMembersByUins(code, [selfUin]);
            member = rows[0] ?? null;
          }
        } catch {
          return null;
        }
        if (!member) return null;

        let detail: import('@weq/db').GroupDetail | null = null;
        let levelConfigs: Array<{ level: number; levelName: string }> = [];
        try {
          detail = await session.groupDetail.getDetail(code);
        } catch {
          detail = null;
        }
        try {
          const info = await session.memberLevelInfo.getLevelInfo(code);
          levelConfigs = info?.levelConfigs ?? [];
        } catch {
          levelConfigs = [];
        }

        const isOwner = Boolean(detail?.ownerUid) && detail?.ownerUid === (member.uid || selfUid);
        return {
          groupCode,
          role: isOwner ? 'owner' : member.adminFlag === 1 ? 'admin' : 'member',
          customTitle: String(member.customTitle ?? '').trim(),
          memberLevel: member.memberLevel,
          levelName:
            levelConfigs.find((config) => config.level === member.memberLevel)?.levelName ?? '',
          memberCount: detail?.memberCount || 0,
        };
      },
      /**
       * 群聊互动页的聚合。同窗口记忆化：availability / compute 之间只扫一次全正文。
       * 返回的对象是共享只读的，compute 不原地修改，只在上面做取名与收口。
       */
      async interactionTally(startTime: number, endTime: number) {
        const key = `${startTime}:${endTime}`;
        let running = interactionCache.get(key);
        if (!running) {
          running = session.groupMsgs.tallyInteractions({
            startTime,
            endTime,
            senderUid: selfUid || undefined,
            selfUin: selfUin > 0n ? selfUin : undefined,
          });
          interactionCache.set(key, running);
          // 失败时清掉缓存，页面重试可以重新扫；成功结果保留供重进页面复用。
          void running.catch(() => {
            interactionCache.delete(key);
          });
        }
        return running;
      },
      /** 群资料批量取名。不排序、缺资料即缺席，调用方自己拿群号兜底。 */
      async details(groupCodes: string[]) {
        const unique = [...new Set(groupCodes.filter((code) => /^\d+$/.test(code)))];
        if (unique.length === 0) return [];
        const details = await session.groupDetail.detailsByGroupCodes(
          unique.map((code) => BigInt(code)),
        );
        return details.map((group) => ({
          groupCode: String(group.groupCode),
          groupName: group.groupName || String(group.groupCode),
        }));
      },
      /** 一个群里按 uid/uin 批量解析群名片。两个都传时按 uid 去重。 */
      async memberBriefs(groupCode: string, uids: string[], uins: string[]) {
        const code = BigInt(groupCode);
        const uidUnique = [...new Set(uids.filter((uid) => uid))];
        const uinUnique = [...new Set(uins.filter((uin) => /^\d+$/.test(uin)))];
        const [byUid, byUin] = await Promise.all([
          uidUnique.length > 0 ? session.groupMembers.getMembersByUids(code, uidUnique) : [],
          uinUnique.length > 0
            ? session.groupMembers.getMembersByUins(
                code,
                uinUnique.map((uin) => BigInt(uin)),
              )
            : [],
        ]);
        const seen = new Set<string>();
        const rows: Array<{ uid: string; uin: string; card: string; nick: string }> = [];
        for (const member of [...byUid, ...byUin]) {
          const uid = member.uid;
          if (!uid || seen.has(uid)) continue;
          seen.add(uid);
          rows.push({
            uid,
            uin: String(member.uin ?? ''),
            card: String(member.card ?? ''),
            nick: String(member.nick ?? ''),
          });
        }
        return rows;
      },
    },
    c2c: {
      /**
       * 私聊的「会话 × 日」聚合。SQL 与方向判据都在 `C2cMsgDb` 里（和
       * `countByDirection` 同一层），这里只按账号会话透传。
       *
       * 与 countByDirection 同款的 per-window 记忆化：私聊火花页和好友榜页问的是
       * 同一个时间窗的同一批桶（一个问「哪一天」、一个问「哪个人」），共享这一次
       * 全表扫描。**返回的数组是共享只读的**，调用方不得原地修改。
       */
      async peerDayTallies(startTime: number, endTime: number) {
        const key = `${startTime}:${endTime}`;
        let running = dayTallyCache.get(key);
        if (!running) {
          running = session.c2cMsgs.peerDayTallies({ startTime, endTime });
          dayTallyCache.set(key, running);
          // 失败时清掉缓存，页面重试可以重新扫。
          void running.catch(() => {
            dayTallyCache.delete(key);
          });
        }
        return running;
      },
      /**
       * 同款 per-window 记忆化。开场页只有一个查询面，SQL 里会按会话序号排一次
       * 序，因此单独缓存这次结果（与 peerDayTallies 不是同一个聚合，不能共用）。
       */
      async initiationTallies(startTime: number, endTime: number) {
        const key = `${startTime}:${endTime}`;
        let running = initiationCache.get(key);
        if (!running) {
          running = session.c2cMsgs.initiationTallies({ startTime, endTime });
          initiationCache.set(key, running);
          // 失败时清掉缓存，页面重试可以重新扫。
          void running.catch(() => {
            initiationCache.delete(key);
          });
        }
        return running;
      },
      /**
       * 只解码一个会话在某个时间窗内的正文 —— 热词只针对「最忙那天」，
       * 不需要整表 40800 全量解码。
       */
      async peerMessagesInWindow(peerUid: string, startTime: number, endTime: number) {
        const sortNo = session.uidMap.sortNoByUid(peerUid);
        const part = sortNo !== undefined ? { sortNo } : { uid: peerUid };
        return session.c2cMsgs.listTimeWindow(part, { startTime, endTime });
      },
      /**
       * Peer nick / remark / uin 批量解析。profile_info 缓存里没这个人就缺席，
       * 页面用尾号兜底，不在这里做任何 SQL 推断。
       */
      async peerProfiles(uids: string[]) {
        const unique = [...new Set(uids.filter((uid) => uid))];
        if (unique.length === 0) return [];
        const profiles = await session.profileInfo.profilesByUids(unique);
        return profiles.map((profile) => ({
          uid: profile.uid,
          uin: String(profile.uin ?? ''),
          nick: profile.nick,
          remark: profile.remark,
        }));
      },
    },
    rhythm: {
      /**
       * 与 peerDayTallies 同款的 per-window 记忆化：availability 只问一次方向，
       * compute 再取同一时间窗，只扫一遍两张表。
       */
      async sentWeekdayHourlyTallies(startTime: number, endTime: number) {
        const key = `${startTime}:${endTime}`;
        let running = weekdayHourlyCache.get(key);
        if (!running) {
          running = Promise.all([
            session.c2cMsgs.sentWeekdayHourlyTallies({ startTime, endTime }),
            session.groupMsgs.sentWeekdayHourlyTallies({
              startTime,
              endTime,
              ...(selfUid ? { senderUid: selfUid } : selfUin > 0n ? { selfUin } : {}),
            }),
          ]).then(([c2c, group]) => mergeWeekdayHourlyGrids([c2c, group]));
          weekdayHourlyCache.set(key, running);
          // 失败时清掉缓存，页面重试可以重新扫。
          void running.catch(() => {
            weekdayHourlyCache.delete(key);
          });
        }
        return running;
      },
    },
    meta: {
      /**
       * Oldest message sendTime (unix seconds) across c2c + group tables, or
       * null when the account has no stored messages at all. Drives the
       * 「历史以来」span denominator. Two MIN scans, cached by the engine.
       */
      oldestMessageTime,
      /**
       * The years the account actually sent something in — the selectable
       * report years. Two DISTINCT-year scans, cached here for the session.
       */
      sentYears,
    },
  };
}
