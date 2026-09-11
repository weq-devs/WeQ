import type { PageAvailability, ReportPageDefinition } from '../../types';
import { reportYearUnixRange } from '../../time';
import type { MateCandidate, MatePageData, MateSharedGroup } from './types';

/** 推荐位数量：冠军之外再排几位（冠军必须占页面主体，长尾小卡最多四张）。 */
const MORE_KEEP = 4;
/** 每个候选展示的共同群上限 —— 六枚已经足够读出「圈子」，再多就是通讯录。 */
const SHARED_GROUPS_KEEP = 6;

type MemberRow = {
  groupCode: string;
  uid: string;
  uin: string;
  nick: string;
  card: string;
};

/**
 * 还没加好友的同路人 —— 在「群」这张地图上，找和你生态位最重叠的陌生人。
 *
 * 计算分两层：
 *
 *  1. **给群定权**。群 g 对另一个群 h 的「重合度」= |members(g) ∩ members(h)|
 *     / |members(g)|：h 把 g 的人全部装下（g ⊆ h）时是 1，一个都不在时是 0。
 *     群的权重是
 *
 *         W(g) = 1 / (1 + Σ_{h≠g} 重合度(g, h))
 *
 *     十个一模一样的群，每个群的其它九个重合度都是 1，W = 1/10 —— 十个复制群
 *     加起来只算一个兴趣；被一个大群完全包含的小群同理，也不会被重复计权。
 *
 *  2. **给人累权**。每个非好友群友把自己所在的群权重加总 —— 他和你共同的
 *     群越「重」（越独立、越不像复制品），分数越高。冠军要同时满足「共同群
 *     ≥2」，只同群一次的人满大街都是，谈不上重合。
 *
 * 群集取「这一年在其中发过言」的群（沿用主场页 countRows 的活跃群口径），
 * 成员名单取本地当前在群成员快照 —— 群成员表没有历史版本，这是能做到的最
 * 忠于口径的近似。
 */
export const matePage: ReportPageDefinition<MatePageData> = {
  manifest: {
    id: 'mate',
    title: '还没加好友的同路人',
    description: '总在不同的群里遇见同一个人——这大概就叫缘分。',
    order: 13,
    version: '0.1.0',
    apiVersion: 1,
    category: '群聊',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const counts = await q.overview.countByDirection(startSec, endSec);
    const hasGroupSent = counts.groupSent > 0;
    return {
      available: hasGroupSent,
      reason: hasGroupSent ? undefined : '这段时间你在群里没有发言，讲不出和谁的圈子重叠',
    };
  },
  compute: async ({ year, q }): Promise<MatePageData> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const ranked = await q.group.countRows(startSec, endSec);
    if (ranked.length === 0) {
      return { year, groupCount: 0, personCount: 0, top: null, more: [] };
    }

    const byCode = new Map(ranked.map((row) => [row.groupCode, row]));
    const [memberRows, buddies, self, botUids] = await Promise.all([
      q.group.allActiveMembers(),
      q.buddies.list(),
      q.meta.selfIdentity(),
      q.meta.botUids(),
    ]);

    /** 群号 → 去重成员表。key 优先 uid，老记录用 `uin:` 前缀兜底。 */
    const groups = new Map<string, Map<string, MemberRow>>();
    for (const row of memberRows) {
      if (!byCode.has(row.groupCode)) continue;
      const key = memberKey(row);
      if (!key) continue;
      let map = groups.get(row.groupCode);
      if (!map) {
        map = new Map<string, MemberRow>();
        groups.set(row.groupCode, map);
      }
      if (!map.has(key)) map.set(key, row);
    }

    // 名册可能缺 uid（旧版），好友按 uid / uin 双键判重，机器人同样双键排除。
    const friendKeys = new Set<string>();
    for (const buddy of buddies) {
      if (buddy.uid) friendKeys.add(buddy.uid);
      if (buddy.uin) friendKeys.add(`uin:${buddy.uin}`);
    }
    const botKeys = new Set<string>();
    for (const uid of botUids) {
      botKeys.add(uid);
    }
    const selfKeys = new Set<string>();
    if (self.uid) selfKeys.add(self.uid);
    if (self.uin) selfKeys.add(`uin:${self.uin}`);
    const excluded = (key: string): boolean =>
      friendKeys.has(key) || botKeys.has(key) || selfKeys.has(key);

    // 去掉只剩自己的群；它们对「跨群重逢」没有信息量。
    for (const map of groups.values()) {
      for (const key of map.keys()) {
        if (key === self.uid || key === `uin:${self.uin}`) map.delete(key);
      }
    }
    for (const [groupCode, map] of groups) {
      if (map.size === 0) groups.delete(groupCode);
    }
    const groupCodes = [...groups.keys()].filter((code) => groups.get(code)!.size > 0);
    if (groupCodes.length < 2) {
      return {
        year,
        groupCount: groupCodes.length,
        personCount: countPeople(groups, excluded),
        top: null,
        more: [],
      };
    }

    /** 每人在「口径群集」里待过几个群。用于一次性算出其它群对本群的重合度之和。 */
    const memberGroupCount = new Map<string, number>();
    for (const groupCode of groupCodes) {
      const map = groups.get(groupCode)!;
      for (const key of map.keys()) {
        memberGroupCount.set(key, (memberGroupCount.get(key) ?? 0) + 1);
      }
    }

    const weights = new Map<string, number>();
    for (const groupCode of groupCodes) {
      const map = groups.get(groupCode)!;
      let memberships = 0;
      for (const key of map.keys()) memberships += memberGroupCount.get(key) ?? 0;
      // Σ_{h≠g} |g∩h| / |g| = (Σ_成员 成员所在群数 − |g|) / |g|
      const overlap = map.size > 0 ? (memberships - map.size) / map.size : 0;
      weights.set(groupCode, 1 / (1 + overlap));
    }

    type PersonAgg = {
      uid: string;
      uin: string;
      score: number;
      sharedCount: number;
      rows: MemberRow[];
      nameCounts: Map<string, number>;
    };
    const people = new Map<string, PersonAgg>();
    for (const groupCode of groupCodes) {
      const map = groups.get(groupCode)!;
      const weight = weights.get(groupCode) ?? 0;
      for (const [key, row] of map) {
        if (excluded(key)) continue;
        let agg = people.get(key);
        if (!agg) {
          agg = {
            uid: row.uid,
            uin: row.uin,
            score: 0,
            sharedCount: 0,
            rows: [],
            nameCounts: new Map<string, number>(),
          };
          people.set(key, agg);
        }
        agg.score += weight;
        agg.sharedCount += 1;
        agg.rows.push(row);
        const name = cleanName(row);
        if (name) agg.nameCounts.set(name, (agg.nameCounts.get(name) ?? 0) + 1);
      }
    }

    const candidates = [...people.values()]
      .filter((person) => person.sharedCount >= 2)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.sharedCount - a.sharedCount ||
          String(a.uid || a.uin).localeCompare(String(b.uid || b.uin)),
      );

    const toCandidate = (person: PersonAgg): MateCandidate => {
      const groupsOf = person.rows
        .map((row) => {
          const meta = byCode.get(row.groupCode);
          const sharedGroup: MateSharedGroup = {
            groupCode: row.groupCode,
            groupName: meta?.groupName ?? row.groupCode,
            memberCount: meta?.memberCount ?? groups.get(row.groupCode)?.size ?? 0,
            weight: weights.get(row.groupCode) ?? 0,
          };
          return sharedGroup;
        })
        .sort((a, b) => b.weight - a.weight || a.groupCode.localeCompare(b.groupCode))
        .slice(0, SHARED_GROUPS_KEEP);

      const bestName = [...person.nameCounts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'),
      )[0]?.[0];
      const tail = person.uin ? person.uin.slice(-4) : (person.uid || '').slice(-4);
      return {
        uid: person.uid,
        uin: person.uin,
        name: bestName || (tail ? `群友 ${tail}` : '某位群友'),
        score: round3(person.score),
        sharedCount: person.sharedCount,
        groups: groupsOf,
      };
    };

    const top = candidates[0] ? toCandidate(candidates[0]) : null;
    const more = candidates.slice(1, 1 + MORE_KEEP).map((person) => toCandidate(person));
    return {
      year,
      groupCount: groupCodes.length,
      personCount: people.size,
      top,
      more,
    };
  },
};

/** 成员在跨群聚合里的稳定键：uid 优先，老记录退到 QQ 号。 */
function memberKey(row: MemberRow): string {
  const uid = String(row.uid ?? '').trim();
  if (uid) return uid;
  const uin = String(row.uin ?? '').trim();
  return /^\d+$/.test(uin) ? `uin:${uin}` : '';
}

/** 展示名：全局昵称优先，群名片兜底。 */
function cleanName(row: MemberRow): string {
  const nick = String(row.nick ?? '').trim();
  if (nick) return nick;
  return String(row.card ?? '').trim();
}

/** 去重扫过的人（只统计非好友、非机器人、非自己）。 */
function countPeople(
  groups: Map<string, Map<string, MemberRow>>,
  excluded: (key: string) => boolean,
): number {
  const keys = new Set<string>();
  for (const map of groups.values()) {
    for (const key of map.keys()) {
      if (!excluded(key)) keys.add(key);
    }
  }
  return keys.size;
}

/** 浮点只保留展示/落盘需要的三位，避免 JSON 里拖一长串小数。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
