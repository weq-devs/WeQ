import type { PageAvailability, ReportPageDefinition } from '../../types';
import { currentReportYear, isAllTimeYear, reportYearUnixRange } from '../../time';
import type { MonthCompanionCell, MonthsPageData } from './types';

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
export const monthsPage: ReportPageDefinition<MonthsPageData> = {
  manifest: {
    id: 'months',
    title: '陪你走过12个月',
    description: '每个月聊得最多的人，串起你这一年的陪伴。',
    order: 10,
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

    const monthCount = year === currentReportYear() ? new Date().getMonth() + 1 : 12;
    type PeerMonth = { total: number; mine: number };
    const monthBuckets: Array<Map<string, PeerMonth>> = Array.from({ length: monthCount }, () => {
      return new Map<string, PeerMonth>();
    });

    for (const row of tallies) {
      if (!row.date || !row.peerUid) continue;
      const month = Number(row.date.slice(5, 7));
      if (!Number.isInteger(month) || month < 1 || month > monthCount) continue;
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

    const months: MonthCompanionCell[] = [];
    const wantedUids = new Set<string>();
    for (let index = 0; index < monthCount; index++) {
      const bucket = monthBuckets[index]!;
      const candidates = [...bucket.entries()]
        .filter(([, tally]) => tally.mine > 0 && tally.total > tally.mine)
        .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));

      const monthMessages = candidates.reduce((sum, [, tally]) => sum + tally.total, 0);
      const champion = candidates[0];
      if (champion) wantedUids.add(champion[0]);

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

    /** 月榜赢家 + 年度聊伴候选，统一一次批量取名。 */
    let monthWinners = new Set<string>();
    for (const cell of months) {
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

    for (const cell of months) {
      if (!cell.top) continue;
      const uid = cell.top.peerUid;
      const profile = byUid.get(uid);
      cell.top.peerUin = profile?.uin ?? '';
      cell.top.peerName = nameOf(uid);
    }

    const friends = [...yearTotal.entries()];
    const friendCount = friends.length;
    const totalMessages = friends.reduce((sum, [, messages]) => sum + messages, 0);

    const winCount = new Map<string, number>();
    for (const cell of months) {
      if (cell.top) winCount.set(cell.top.peerUid, (winCount.get(cell.top.peerUid) ?? 0) + 1);
    }
    const championUid = [...winCount.entries()].sort((a, b) => {
      const byWins = b[1] - a[1];
      if (byWins !== 0) return byWins;
      return (yearTotal.get(b[0]) ?? 0) - (yearTotal.get(a[0]) ?? 0);
    })[0]?.[0];

    const champion = championUid
      ? {
          peerUid: championUid,
          peerUin: byUid.get(championUid)?.uin ?? '',
          peerName: nameOf(championUid),
          messages: yearTotal.get(championUid) ?? 0,
        }
      : null;

    return {
      year,
      monthCount,
      friendCount,
      totalMessages,
      champion,
      championMonths: champion ? (winCount.get(champion.peerUid) ?? 0) : 0,
      months,
    };
  },
};
