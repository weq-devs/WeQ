import type { PageAvailability, ReportPageDefinition } from '../../types';
import { currentReportYear, isAllTimeYear, reportYearUnixRange } from '../../time';
import type { MonthCompanionCell, MonthsPageData, CarryoverMonth } from './types';

/**
 * 陪你走过 12 个月 —— 把「好友榜」按月拆开，看的是时间怎么筛人。
 *
 * 好友榜把一整年压成一个数字，这一页把它摊回月历：每个月取双向私聊最多的
 * 好友，十二枚格子连起来，谁霸榜最多、谁就配得上「年度聊伴」这个名字。
 *
 * 数据与好友榜同源 —— `peerDayTallies` 那一次「会话 × 本地日」无正文扫描按
 * 时间窗记忆化，两页共享，这里只在 compute 里按月分桶。好友定义也沿用好友榜：
 * 「这一年我发过、并且对方也发过」的双向往来；单向推送号、验证码不会霸占月榜。
 *
 * 历史以来口径没有「12 个月」这个故事，availability 直接把它挡在 deck 外。
 */

/**
 * 榜上只放好友名单里的人：公众号 / 服务号偶尔自动回复也能过「双向来往」
 * 门槛。buddy_list 是「是不是好友」的权威来源；拉取失败时返回 null 退回
 * 不过滤 —— 不能因为名单挂了就把月历清空。
 */
async function buddyUidSet(q: import('../../types').ReportQueries): Promise<Set<string> | null> {
  try {
    const buddies = await q.buddies.list();
    const uids = new Set(buddies.map((buddy) => buddy.uid));
    return uids.size > 0 ? uids : null;
  } catch {
    return null;
  }
}

export const monthsPage: ReportPageDefinition<MonthsPageData> = {
  manifest: {
    id: 'months',
    title: '陪你走过12个月',
    description: '十二个月的榜首轮流坐，有人却始终没下过榜。',
    order: 12,
    version: '0.1.0',
    apiVersion: 1,
    category: '私聊',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    if (isAllTimeYear(year)) {
      return { available: false, reason: '历史以来没有「12 个月」的月历可讲' };
    }
    const { startSec, endSec } = reportYearUnixRange(year);
    const counts = await q.overview.countByDirection(startSec, endSec);
    const hasSent = counts.c2cSent > 0;
    return {
      available: hasSent,
      reason: hasSent ? undefined : '这一年你没有发出过私聊消息',
    };
  },
  compute: async ({ year, q }): Promise<MonthsPageData> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const tallies = await q.c2c.peerDayTallies(startSec, endSec);
    // 公众号 / 服务号不配霸占月历 —— 见 buddyUidSet。
    const buddies = await buddyUidSet(q);

    /**
     * 「走过的月份」：当年只画到当前月为止 —— 未来的月份还没有资格。
     * 剩下的月份由滚动补足用去年同月填满（见下），日历永远铺满 12 格。
     */
    const currentYearMonths = year === currentReportYear() ? new Date().getMonth() + 1 : 12;

    type PeerMonth = { total: number; mine: number };
    const monthBuckets: Array<Map<string, PeerMonth>> = Array.from(
      { length: currentYearMonths },
      () => new Map<string, PeerMonth>(),
    );

    for (const row of tallies) {
      if (!row.date || !row.peerUid) continue;
      if (buddies !== null && !buddies.has(row.peerUid)) continue;
      const month = Number(row.date.slice(5, 7));
      if (!Number.isInteger(month) || month < 1 || month > currentYearMonths) continue;
      const bucket = monthBuckets[month - 1]!;
      const prev = bucket.get(row.peerUid) ?? { total: 0, mine: 0 };
      prev.total += row.total;
      prev.mine += row.mine;
      bucket.set(row.peerUid, prev);
    }

    /** 全年口径的「好友」：这一年我发过、且对方也发过。 */
    const yearTotal = new Map<string, number>();
    for (const bucket of monthBuckets) {
      for (const [uid, tally] of bucket) {
        if (tally.mine > 0 && tally.total > tally.mine) {
          yearTotal.set(uid, (yearTotal.get(uid) ?? 0) + tally.total);
        }
      }
    }
    /** 页面上「看得见的那 12 格」的总消息量：今年 + 去年补足格。 */
    const windowTotal = new Map(yearTotal);

    const months: MonthCompanionCell[] = [];
    for (let index = 0; index < currentYearMonths; index++) {
      const bucket = monthBuckets[index]!;
      const candidates = [...bucket.entries()]
        .filter(([, tally]) => tally.mine > 0 && tally.total > tally.mine)
        .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));

      const monthMessages = candidates.reduce((sum, [, tally]) => sum + tally.total, 0);
      const champion = candidates[0];

      months.push({
        month: index + 1,
        monthMessages,
        top: champion
          ? {
              peerUid: champion[0],
              peerUin: '',
              peerName: '',
              messages: champion[1].total,
            }
          : null,
      });
    }

    // ── 滚动补足：当年的月份不足 12 时，用去年对应的尾部月份把日历铺满。 ──
    // 例如现在 9 月，12 个月 = 去年 10-12 月 + 今年 1-9 月；所以去年只需要
    // 补 currentYearMonths+1..12 这一段，数组升序交给渲染层排在今年前面。
    let carryover: CarryoverMonth[] = [];
    if (currentYearMonths < 12) {
      const lastYear = year - 1;
      const { startSec: lyStart, endSec: lyEnd } = reportYearUnixRange(lastYear);
      const lyTallies = await q.c2c.peerDayTallies(lyStart, lyEnd);
      const lyBuckets: Array<Map<string, PeerMonth>> = Array.from(
        { length: 12 },
        () => new Map<string, PeerMonth>(),
      );
      for (const row of lyTallies) {
        if (!row.date || !row.peerUid) continue;
        if (buddies !== null && !buddies.has(row.peerUid)) continue;
        const month = Number(row.date.slice(5, 7));
        if (!Number.isInteger(month) || month <= currentYearMonths || month > 12) continue;
        const bucket = lyBuckets[month - 1]!;
        const prev = bucket.get(row.peerUid) ?? { total: 0, mine: 0 };
        prev.total += row.total;
        prev.mine += row.mine;
        bucket.set(row.peerUid, prev);
      }
      // 补足月只取“今年尾部之后”的 12 - currentYearMonths 个月；把它们的有来有往
      // 合并进 windowTotal，冠军的「近 12 个月聊了多少句」才算得全。
      for (const bucket of lyBuckets) {
        for (const [uid, tally] of bucket) {
          if (tally.mine > 0 && tally.total > tally.mine) {
            windowTotal.set(uid, (windowTotal.get(uid) ?? 0) + tally.total);
          }
        }
      }
      carryover = [];
      for (let month = currentYearMonths + 1; month <= 12; month++) {
        const bucket = lyBuckets[month - 1]!;
        const candidates = [...bucket.entries()]
          .filter(([, tally]) => tally.mine > 0 && tally.total > tally.mine)
          .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
        const champion = candidates[0];
        carryover.push({
          month,
          top: champion
            ? {
                peerUid: champion[0],
                peerUin: '',
                peerName: '',
                messages: champion[1].total,
              }
            : null,
        });
      }
    }

    /** 月榜赢家 + 年度聊伴候选 + 去年补足格的人，统一一次批量取名。 */
    let monthWinners = new Set<string>();
    for (const cell of months) {
      if (cell.top) monthWinners.add(cell.top.peerUid);
    }
    for (const cell of carryover) {
      if (cell.top) monthWinners.add(cell.top.peerUid);
    }
    monthWinners = new Set([...monthWinners].sort((a, b) => a.localeCompare(b)));
    const profiles = await q.c2c.peerProfiles([...monthWinners]);
    const byUid = new Map(profiles.map((profile) => [profile.uid, profile]));
    const nameOf = (uid: string): string => {
      const profile = byUid.get(uid);
      if (!profile) return `QQ ${uid.slice(-4)}`;
      return profile.remark || profile.nick || `QQ ${(profile.uin || uid).slice(-4)}`;
    };

    for (const cell of [...months, ...carryover]) {
      if (!cell.top) continue;
      const uid = cell.top.peerUid;
      const profile = byUid.get(uid);
      cell.top.peerUin = profile?.uin ?? '';
      cell.top.peerName = nameOf(uid);
    }

    const friends = [...yearTotal.entries()];
    const friendCount = friends.length;
    const totalMessages = friends.reduce((sum, [, messages]) => sum + messages, 0);

    // 冠军和胜场数都按**渲染出来的那 12 个月**数：今年走过的月份 + 去年尾部
    // 补足格。否则月历里明明描亮的“去年”格不会计入“共陪你走过几个月”。
    const winCount = new Map<string, number>();
    for (const cell of [...months, ...carryover]) {
      if (cell.top) winCount.set(cell.top.peerUid, (winCount.get(cell.top.peerUid) ?? 0) + 1);
    }
    const championUid = [...winCount.entries()].sort((a, b) => {
      const byWins = b[1] - a[1];
      if (byWins !== 0) return byWins;
      return (windowTotal.get(b[0]) ?? 0) - (windowTotal.get(a[0]) ?? 0);
    })[0]?.[0];

    const champion = championUid
      ? {
          peerUid: championUid,
          peerUin: byUid.get(championUid)?.uin ?? '',
          peerName: nameOf(championUid),
          messages: windowTotal.get(championUid) ?? 0,
        }
      : null;

    return {
      year,
      monthCount: currentYearMonths,
      friendCount,
      totalMessages,
      champion,
      championMonths: champion ? (winCount.get(champion.peerUid) ?? 0) : 0,
      months,
      /** 满年时没有补足格 —— 渲染层据此决定要不要画「去年」的角标。 */
      carryoverMonths: carryover,
    };
  },
};
