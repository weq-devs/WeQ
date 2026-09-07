import type { PageAvailability, ReportPageDefinition } from '../../types';
import { reportYearUnixRange } from '../../time';
import { dayIndex, longestRun } from '../../day_runs';
import type { FriendRankEntry, FriendsPageData } from './types';

/**
 * 两榜的名次数。不一样，是因为渲染形状不同：火花是三条纵向堆叠的横引线，
 * 消息量是一排横向铺开的纵柱子 —— 前者再多会压垮版面，后者三根撑不满一行。
 */
const SPARK_TOP_N = 3;
const MESSAGE_TOP_N = 8;

/**
 * 好友榜 —— 两张只取前三的榜，同一批人两种排法。
 *
 * 和私聊火花页同源：底层还是 `C2cMsgDb.peerDayTallies` 那一次「会话 × 本地日」
 * 无正文扫描（`ReportQueries.c2c.peerDayTallies` 按时间窗记忆化，所以两页合起来
 * 只扫一遍库）。区别在于火花页问的是「哪一天」，这一页问的是「哪个人」：
 *
 *  1. **最长火花榜** —— 每个人「双方当天都有消息」的最长连续天数，取前三；
 *  2. **最多消息榜** —— 每个人双方合计的私聊条数，取前八。
 *
 * 两榜取的名次数不同，是因为渲染形状不同：火花是三条横向引线（纵向堆叠，
 * 再多就压垮版面），消息量是一排纵向柱子（横向铺开，三根撑不满一行）。
 *
 * 两张榜共用同一份「好友」定义：这段时间里**我发过、并且对方也发过**的会话。
 * 单向的推送号、验证码、只收不回的陌生人因此都不会占榜位 —— 这是一页关于人的
 * 排行，不是关于消息量的排行。
 */
export const friendsPage: ReportPageDefinition<FriendsPageData> = {
  manifest: {
    id: 'friends',
    title: '好友榜',
    description: '烧得最久的火花、聊得最多的人。',
    order: 4,
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

    /** 一个会话在整个口径内的汇总。`mutualDays` 是「双方当天都说了话」的日索引。 */
    type Bucket = { total: number; mine: number; mutualDays: number[] };
    const buckets = new Map<string, Bucket>();
    for (const row of tallies) {
      if (!row.date || !row.peerUid) continue;
      let bucket = buckets.get(row.peerUid);
      if (!bucket) {
        bucket = { total: 0, mine: 0, mutualDays: [] };
        buckets.set(row.peerUid, bucket);
      }
      bucket.total += row.total;
      bucket.mine += row.mine;
      if (row.mine > 0 && row.total > row.mine) bucket.mutualDays.push(dayIndex(row.date));
    }

    // 「好友」= 我发过 且 对方也发过。两张榜共用这一个门槛。
    const friends = [...buckets.entries()].filter(
      ([, bucket]) => bucket.mine > 0 && bucket.total > bucket.mine,
    );

    const messageRanked = friends
      .slice()
      .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
      .slice(0, MESSAGE_TOP_N);

    const sparkRanked = friends
      .map(([uid, bucket]) => {
        const days = longestRun([...new Set(bucket.mutualDays)].sort((a, b) => a - b));
        return { uid, bucket, days };
      })
      .filter((row) => row.days > 0)
      // 天数并列时让聊得更多的那位在前，再并列按 uid 稳定排序。
      .sort(
        (a, b) => b.days - a.days || b.bucket.total - a.bucket.total || a.uid.localeCompare(b.uid),
      )
      .slice(0, SPARK_TOP_N);

    // 需要名字和头像的最多十一个人（两榜可能重叠）。
    const wantedUids = new Set<string>([
      ...messageRanked.map(([uid]) => uid),
      ...sparkRanked.map((row) => row.uid),
    ]);
    const profiles = await q.c2c.peerProfiles([...wantedUids]);
    const byUid = new Map(profiles.map((profile) => [profile.uid, profile]));
    const entry = (uid: string, value: number, messages: number): FriendRankEntry => {
      const profile = byUid.get(uid);
      return {
        peerUid: uid,
        peerUin: profile?.uin ?? '',
        peerName: profile?.remark || profile?.nick || `QQ ${(profile?.uin || uid).slice(-4)}`,
        value,
        messages,
      };
    };

    return {
      year,
      sparkTop: sparkRanked.map((row) => entry(row.uid, row.days, row.bucket.total)),
      messageTop: messageRanked.map(([uid, bucket]) => entry(uid, bucket.total, bucket.total)),
      friendCount: friends.length,
      totalMessages: friends.reduce((sum, [, bucket]) => sum + bucket.total, 0),
    };
  },
};
