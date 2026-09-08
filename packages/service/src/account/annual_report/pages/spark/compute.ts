import type { PageAvailability, ReportPageDefinition } from '../../types';
import { currentReportYear, reportYearUnixRange } from '../../time';
import { dayIndex, longestRun } from '../../day_runs';
import { segmentWords } from '../../../text_segment';
import type { C2cMsg } from '@weq/db';
import type { SparkBest, SparkPageData, SparkTopDay, SparkWallDay } from './types';

/**
 * 私聊火花 —— 一份只属于 c2c 的高光页。
 *
 * 数据路径刻意不在这里写任何 SQL：所有底层聚合都在 `@weq/db` 的
 * `C2cMsgDb.peerDayTallies`（一次无正文扫描，按「会话 × 本地日」出桶）。
 * 页面把桶里的数据组装成四个故事：
 *
 *  1. **最忙的一天** —— 全部私聊中单会话单日合计条数最高者；
 *  2. **绿墙** —— 自己每天发过的私聊条数（自然年口径出一张当年墙；历史以来
 *     口径按年下发，前端可逐年切换）；
 *  3. **自己** —— 发过消息的总天数 + 最长连续发言；
 *  4. **火花** —— 同一个人双方天天都有消息的最长连续天数。
 *
 * 只有「自己发出过至少一条私聊」才出现在 deck 里：全部指标都建立在
 * 自己的发言上，别人单方面发的私聊不构成这份高光。
 */
export const sparkPage: ReportPageDefinition<SparkPageData> = {
  manifest: {
    id: 'spark',
    title: '私聊火花',
    description: '聊得最滚烫的那一天，烧得最久的那段火花。',
    order: 3,
    version: '0.1.0',
    apiVersion: 1,
    category: '私聊',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const counts = await q.overview.countByDirection(startSec, endSec);
    const hasC2cSent = counts.c2cSent > 0;
    return {
      available: hasC2cSent,
      reason: hasC2cSent
        ? undefined
        : year === 0
          ? '这段时间你没有发出过私聊消息'
          : '这一年你没有发出过私聊消息',
    };
  },
  compute: async ({ year, q }) => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const tallies = await q.c2c.peerDayTallies(startSec, endSec);

    /**
     * 滚动补足：当年只过了几个月时，绿墙的「近一年」往前接到去年 ——
     * 窗口 = [去年 (当前月+1) 月 1 日, 今年当前月月末]，始终覆盖近 12 个
     * 月，而不是一整年只剩头几个月的稀疏墙。往年报告与当年 12 月都是
     * 完整自然年，不需要滚动。
     */
    const thisYear = currentReportYear();
    const thisMonth = new Date().getMonth() + 1;
    const rolling =
      year === thisYear && thisMonth < 12
        ? { fromYear: year - 1, fromMonth: thisMonth + 1, toYear: year, toMonth: thisMonth }
        : null;

    const trailingTallies = rolling
      ? await q.c2c.peerDayTallies(
          Math.floor(new Date(rolling.fromYear, rolling.fromMonth - 1, 1).getTime() / 1000),
          Math.floor(new Date(year, 0, 1).getTime() / 1000),
        )
      : [];

    const selfByDate = new Map<string, number>();
    const peerBuckets = new Map<string, number[]>();
    let sentTotal = 0;
    let bestTotal = 0;
    let bestMine = 0;
    let bestRow: { peerUid: string; date: string; total: number; mine: number } | null = null;

    /** 主指标（最忙一天 / 火花 / 发言总量）始终只算报告口径内的天数。 */
    const inReportWindow = (date: string): boolean => {
      const rowYear = Number(date.slice(0, 4));
      return year === 0 || rowYear === year;
    };

    for (const row of [...tallies, ...trailingTallies]) {
      if (!row.date || !row.peerUid) continue;
      const countsForStats = inReportWindow(row.date);
      if (countsForStats) {
        sentTotal += row.mine;
        if (row.mine > 0 && row.total > row.mine) {
          const days = peerBuckets.get(row.peerUid);
          if (days) days.push(dayIndex(row.date));
          else peerBuckets.set(row.peerUid, [dayIndex(row.date)]);
        }
        if (
          row.total > bestTotal ||
          (row.total === bestTotal && row.mine > bestMine) ||
          (row.total === bestTotal && row.mine === bestMine && row.date > (bestRow?.date ?? ''))
        ) {
          bestTotal = row.total;
          bestMine = row.mine;
          bestRow = row;
        }
      }
      // 绿墙吃整个窗口（含去年补足段）：滚动时把窗口外未来的日期也挡掉。
      if (rolling) {
        const [y, m] = [Number(row.date.slice(0, 4)), Number(row.date.slice(5, 7))];
        const before = y < rolling.fromYear || (y === rolling.fromYear && m < rolling.fromMonth);
        const after = y > rolling.toYear || (y === rolling.toYear && m > rolling.toMonth);
        if (before || after) continue;
      }
      selfByDate.set(row.date, (selfByDate.get(row.date) ?? 0) + row.mine);
    }

    // 绿墙：自己发过消息的每一天，按 (year, date) 升序。
    const wallDays: SparkWallDay[] = [];
    const wallYears = new Set<number>();
    for (const [date, count] of [...selfByDate.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const [y, m, d] = date.split('-').map(Number);
      if (!y || !m || !d) continue;
      wallDays.push({ year: y, month: m, day: d, count });
      wallYears.add(y);
    }
    const sortedYears = [...wallYears].sort((a, b) => a - b);
    const wallYear = year > 0 && sortedYears.includes(year) ? year : (sortedYears.at(-1) ?? 0);
    // 滚动墙没有「墙年」的概念 —— 年份标签由窗口自证，这里仍给当年做兜底。
    const wallWindow = rolling && wallYear === year ? rolling : null;

    // 自己：发过消息的天数 + 最长连续发言。
    const activeDays = selfByDate.size;
    const sortedSelfDates = [...selfByDate.keys()].sort();
    const longestSelfRun = longestRun(sortedSelfDates.map((date) => dayIndex(date)));

    // 火花：每个会话找「双方当天都有消息」的连续段。
    let spark: SparkBest | null = null;
    for (const [peerUid, mutualDays] of peerBuckets) {
      const best = longestRun([...new Set(mutualDays)].sort((a, b) => a - b));
      if (best > (spark?.days ?? 0)) {
        spark = {
          days: best,
          peerUid,
          peerUin: '',
          peerName: '',
        };
      }
    }

    // 需要显示名字的只有两个会话：最忙那天 + 最长火花（可能是同一个）。
    const wantedUids = new Set<string>();
    if (bestRow) wantedUids.add(bestRow.peerUid);
    if (spark) wantedUids.add(spark.peerUid);
    const profiles = await q.c2c.peerProfiles([...wantedUids]);
    const byUid = new Map(profiles.map((p) => [p.uid, p]));
    const displayName = (uid: string): string => {
      const profile = byUid.get(uid);
      return profile?.remark || profile?.nick || `QQ ${(profile?.uin || uid).slice(-4)}`;
    };

    let topDay: SparkTopDay | null = null;
    if (bestRow) {
      const [topYear, topMonth, topDayOfMonth] = bestRow.date.split('-').map(Number);
      const from = new Date(topYear!, topMonth! - 1, topDayOfMonth!);
      const to = new Date(topYear!, topMonth! - 1, topDayOfMonth! + 1);
      const msgs = await q.c2c.peerMessagesInWindow(
        bestRow.peerUid,
        from.getTime() / 1000,
        to.getTime() / 1000,
      );
      topDay = {
        date: bestRow.date,
        year: topYear!,
        month: topMonth!,
        day: topDayOfMonth!,
        peerUid: bestRow.peerUid,
        peerUin: byUid.get(bestRow.peerUid)?.uin ?? '',
        peerName: displayName(bestRow.peerUid),
        total: bestRow.total,
        mine: bestRow.mine,
        words: topWords(msgs, 1),
      };
    }

    if (spark) {
      spark.peerUin = byUid.get(spark.peerUid)?.uin ?? '';
      spark.peerName = displayName(spark.peerUid);
    }

    return {
      year,
      wallYears: sortedYears,
      wallYear,
      /**
       * 当年的「近 12 个月」滚动窗口（去年某月 → 今年当前月）。null =
       * 完整自然年墙。绿墙按这个窗口画，主指标不受影响。
       */
      wallWindow,
      wallDays,
      topDay,
      sentTotal,
      activeDays,
      longestSelfRun,
      spark,
    };
  },
};

/** 那几天的正文 → 去掉虚词后的高频词。 */
function topWords(messages: C2cMsg[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    for (const element of message.elements) {
      if (element.kind !== 'text') continue;
      const content = 'textContent' in element ? element.textContent : '';
      if (!content) continue;
      for (const word of segmentWords(String(content))) {
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([word]) => word);
}
