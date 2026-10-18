/**
 * BuddyAnalyticsService — one-on-one (c2c) chat analytics for a single peer.
 *
 * Scans the whole conversation once (oldest→newest via the indexed sortNo
 * partition) and derives: per-side hourly activity, a daily heatmap, the
 * conversation-initiation split, reply latencies (orphan replies excluded by
 * conversation-gap segmentation), the longest mutual-active streak (火花),
 * message-type ratio, per-side common words / faces, and a combined word cloud.
 */

import type { AccountSession } from '@weq/account';
import { CONVERSATION_GAP_SECONDS, type BrowseCursor, type C2cPartition } from '@weq/db';
import { segmentWords } from './text_segment';
import {
  analyticsBrowseFilter,
  analyticsDayParts,
  validateAnalyticsRange,
  type AnalyticsRange,
} from '../common/analytics_time';
import {
  buildWeekKeys,
  dailyToWeekly,
  seriesForWeeks,
  weekStartKey,
  type WeeklyCount,
} from './analytics_weeks';

/** A silence longer than this splits two conversations (seconds). Replies that
 *  straddle a split are treated as a fresh initiation, not a reply — which is
 *  exactly how we avoid counting "orphan" replies to a message that actually
 *  ended the previous conversation. The constant lives in `@weq/db` and is shared
 *  with the annual report's all-private-chat aggregate. */

export interface BuddyReplyStats {
  fastestSec: number;
  slowestSec: number;
  avgSec: number;
  count: number;
}

/** 全历史时间轴（不随所选区间变化）。 */
export interface BuddyAnalyticsTimeline {
  firstMessageTime: number | null;
  lastMessageTime: number | null;
  daily: Array<{ date: string; count: number }>;
  weekly: WeeklyCount[];
}

/** 本次统计实际覆盖的区间（unix 秒；无数据时为 null）。 */
export interface BuddyAnalyticsRange {
  startTime: number | null;
  endTime: number | null;
  /** true = 调用方没传区间，服务层按「最近一年」自动确定。 */
  defaulted: boolean;
}

export interface BuddyAnalytics {
  peer: { uid: string; uin: string };
  self: { uin: string };
  statistics: {
    totalMessages: number;
    selfMessages: number;
    peerMessages: number;
    firstMessageTime: number | null;
    lastMessageTime: number | null;
    activeDays: number;
  };
  /** Mutually-exclusive per-message type tally (for the ratio bar). */
  messageTypes: {
    text: number;
    image: number;
    voice: number;
    video: number;
    emoji: number;
    other: number;
  };
  hourlySelf: Record<number, number>;
  hourlyPeer: Record<number, number>;
  /** 所选区间内每天的条数（随选择变化）。 */
  daily: Array<{ date: string; count: number }>;
  /** 全历史时间轴（绿墙与 GitHub 式周柱状图用）。 */
  timeline: BuddyAnalyticsTimeline;
  range: BuddyAnalyticsRange;
  /** 区间周序列（周一起点）。 */
  weeks: string[];
  /** 区间内双方每周消息数（与 weeks 对齐，成员卡 sparkline 用）。 */
  weeklySelf: number[];
  weeklyPeer: number[];
  initiation: { self: number; peer: number; total: number };
  reply: { self: BuddyReplyStats | null; peer: BuddyReplyStats | null };
  /** Consecutive days where BOTH sides spoke (QQ 火花). */
  streak: { longest: number; current: number };
  phrasesSelf: Array<{ phrase: string; count: number }>;
  phrasesPeer: Array<{ phrase: string; count: number }>;
  emojisSelf: Array<{ faceId: number; faceText: string; count: number }>;
  emojisPeer: Array<{ faceId: number; faceText: string; count: number }>;
  wordCloud: Array<{ word: string; count: number }>;
}

type EmojiTally = Map<string, { faceId: number; faceText: string; count: number }>;

function bumpEmoji(tally: EmojiTally, faceId: number, faceText: string): void {
  const key = String(faceId);
  const prev = tally.get(key);
  tally.set(key, {
    faceId,
    faceText: faceText || prev?.faceText || '',
    count: (prev?.count ?? 0) + 1,
  });
}

function topEmojis(tally: EmojiTally, n: number) {
  return [...tally.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

function topWords(counts: Map<string, number>, n: number) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([phrase, count]) => ({ phrase, count }));
}

function longestRun(days: number[]): { longest: number; current: number } {
  if (days.length === 0) return { longest: 0, current: 0 };
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  let longest = 1;
  let run = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! === sorted[i - 1]! + 1) run += 1;
    else run = 1;
    if (run > longest) longest = run;
    current = run; // run ending at the latest mutual day
  }
  return { longest, current };
}

export class BuddyAnalyticsService {
  constructor(private readonly session: AccountSession) {}

  private c2cPartition(peerUid: string): C2cPartition {
    const sortNo = this.session.uidMap.sortNoByUid(peerUid);
    return sortNo !== undefined ? { sortNo } : { uid: peerUid };
  }

  async listAnalysisPeers() {
    const peers = new Map<
      string,
      { uid: string; uin: string; name: string; source: 'directory' | 'messages' }
    >();
    const [history, buddies] = await Promise.all([
      this.session.c2cMsgs.listPeerIdentities(),
      (async () => {
        const rows = [];
        for (let offset = 0; ; offset += 500) {
          const page = await this.session.buddies.listBuddies(500, offset);
          rows.push(...page);
          if (page.length < 500) return rows;
        }
      })(),
    ]);
    for (const row of history) peers.set(row.uid, { ...row, name: '', source: 'messages' });
    for (const row of buddies) {
      if (!row.uid) continue;
      peers.set(row.uid, {
        uid: row.uid,
        uin: row.uin > 0n ? String(row.uin) : peers.get(row.uid)?.uin || '',
        name: '',
        source: 'directory',
      });
    }
    const items = [...peers.values()];
    for (let i = 0; i < items.length; i += 500) {
      const profiles = await this.session.profileInfo.profilesByUids(
        items.slice(i, i + 500).map((row) => row.uid),
      );
      for (const profile of profiles) {
        const row = peers.get(profile.uid);
        if (!row) continue;
        row.name = profile.remark || profile.nick;
        if (profile.uin > 0n) row.uin = String(profile.uin);
      }
    }
    return items.map((row) => ({ ...row, name: row.name || row.uin || row.uid }));
  }

  async getBuddyAnalytics(
    peerUid: string,
    opts: AnalyticsRange & { recentYear?: boolean } = {},
  ): Promise<BuddyAnalytics> {
    const db = this.session.c2cMsgs;
    const part = this.c2cPartition(peerUid);
    const range = validateAnalyticsRange(opts);
    const filter = analyticsBrowseFilter({ messageIds: range.messageIds });
    const selfUin = String(this.session.context.uin ?? '');

    // 默认「最近一年」：以最后一条消息为基准（不是 now），否则早就不聊的
    // 会话打开就是空图。
    let startTime = range.startTime;
    let endTime = range.endTime;
    let defaulted = false;
    if (startTime === undefined && endTime === undefined) {
      const latest = opts?.recentYear ? await db.listLatest(part, 1) : [];
      const newest = latest[0] ? Number(latest[0].sendTime) : 0;
      if (newest > 0) {
        defaulted = true;
        endTime = newest;
        startTime = newest - 365 * 86400;
      }
    }
    const hasRange = startTime !== undefined || endTime !== undefined;

    const stats = {
      totalMessages: 0,
      selfMessages: 0,
      peerMessages: 0,
      firstMessageTime: null as number | null,
      lastMessageTime: null as number | null,
      activeDays: 0,
    };
    const messageTypes = { text: 0, image: 0, voice: 0, video: 0, emoji: 0, other: 0 };

    const hourlySelf: Record<number, number> = {};
    const hourlyPeer: Record<number, number> = {};
    for (let i = 0; i < 24; i++) {
      hourlySelf[i] = 0;
      hourlyPeer[i] = 0;
    }

    const daily = new Map<string, number>();
    const globalDaily = new Map<string, number>();
    const weeklySelfCounts = new Map<string, number>();
    const weeklyPeerCounts = new Map<string, number>();
    let timelineFirst: number | null = null;
    let timelineLast: number | null = null;
    const selfDays = new Set<number>();
    const peerDays = new Set<number>();

    const phrasesSelf = new Map<string, number>();
    const phrasesPeer = new Map<string, number>();
    const emojisSelf: EmojiTally = new Map();
    const emojisPeer: EmojiTally = new Map();
    const wordCloud = new Map<string, number>();

    const initiation = { self: 0, peer: 0, total: 0 };
    const replyAgg = {
      self: { fastest: Infinity, slowest: 0, sum: 0, count: 0 },
      peer: { fastest: Infinity, slowest: 0, sum: 0, count: 0 },
    };

    let peerUin = '';
    let prevSender: 'self' | 'peer' | null = null;
    let prevTime = 0;

    let cursor: BrowseCursor | undefined;
    while (true) {
      const batch = await db.browse(part, filter, cursor, 500, 'newer');
      if (batch.length === 0) break;

      for (const { message: msg } of batch) {
        const isSelf = msg.senderUid !== peerUid;
        if (!isSelf && !peerUin && msg.senderUin > 0n) peerUin = String(msg.senderUin);
        if (!peerUin && msg.targetUin > 0n) peerUin = String(msg.targetUin);

        const sendTime = Number(msg.sendTime);

        // 全历史时间轴：不管是否落在所选区间都记 —— 绿墙 / 顶部周图看的是全史。
        const calendar = analyticsDayParts(sendTime);
        if (calendar) {
          const key = calendar.day;
          globalDaily.set(key, (globalDaily.get(key) ?? 0) + 1);
          if (timelineFirst === null || sendTime < timelineFirst) timelineFirst = sendTime;
          if (timelineLast === null || sendTime > timelineLast) timelineLast = sendTime;
        }

        if (
          hasRange &&
          (sendTime <= 0 ||
            (startTime !== undefined && sendTime < startTime) ||
            (endTime !== undefined && sendTime > endTime))
        )
          continue;

        stats.totalMessages++;
        if (isSelf) stats.selfMessages++;
        else stats.peerMessages++;

        // ---- element classification -------------------------------------
        let hasText = false;
        let hasImage = false;
        let hasVoice = false;
        let hasVideo = false;
        let hasEmoji = false;
        for (const el of msg.elements) {
          switch (el.kind) {
            case 'text':
              hasText = true;
              if (el.textContent) {
                for (const word of segmentWords(String(el.textContent))) {
                  wordCloud.set(word, (wordCloud.get(word) ?? 0) + 1);
                  const bucket = isSelf ? phrasesSelf : phrasesPeer;
                  bucket.set(word, (bucket.get(word) ?? 0) + 1);
                }
              }
              break;
            case 'at':
              hasText = true;
              break;
            case 'pic':
              hasImage = true;
              break;
            case 'ptt':
              hasVoice = true;
              break;
            case 'video':
              hasVideo = true;
              break;
            case 'face': {
              hasEmoji = true;
              const faceId = Number(el.faceId);
              if (Number.isFinite(faceId)) {
                bumpEmoji(
                  isSelf ? emojisSelf : emojisPeer,
                  faceId,
                  el.faceText ? String(el.faceText) : '',
                );
              }
              break;
            }
            case 'mface':
            case 'emojiBounce':
              hasEmoji = true;
              break;
          }
        }

        // Mutually-exclusive type for the ratio bar (media dominates a caption).
        if (hasImage) messageTypes.image++;
        else if (hasVideo) messageTypes.video++;
        else if (hasVoice) messageTypes.voice++;
        else if (hasText) messageTypes.text++;
        else if (hasEmoji) messageTypes.emoji++;
        else messageTypes.other++;

        // ---- time-based aggregates --------------------------------------
        const date = analyticsDayParts(sendTime);
        if (date) {
          if (stats.firstMessageTime === null || sendTime < stats.firstMessageTime) {
            stats.firstMessageTime = sendTime;
          }
          if (stats.lastMessageTime === null || sendTime > stats.lastMessageTime) {
            stats.lastMessageTime = sendTime;
          }
          const hour = date.hour;
          if (isSelf) hourlySelf[hour] = (hourlySelf[hour] ?? 0) + 1;
          else hourlyPeer[hour] = (hourlyPeer[hour] ?? 0) + 1;

          const key = date.day;
          daily.set(key, (daily.get(key) ?? 0) + 1);
          (isSelf ? selfDays : peerDays).add(date.dayIndex);
          const week = weekStartKey(new Date(sendTime * 1000));
          const weekMap = isSelf ? weeklySelfCounts : weeklyPeerCounts;
          weekMap.set(week, (weekMap.get(week) ?? 0) + 1);

          // ---- conversation segmentation: initiation + reply latency ----
          const sender: 'self' | 'peer' = isSelf ? 'self' : 'peer';
          const gap = prevSender === null ? Infinity : sendTime - prevTime;
          if (gap > CONVERSATION_GAP_SECONDS) {
            // New conversation — this sender initiated it.
            initiation[sender]++;
            initiation.total++;
          } else if (sender !== prevSender) {
            // A genuine within-conversation reply to the other party.
            const agg = replyAgg[sender];
            agg.count++;
            agg.sum += gap;
            if (gap < agg.fastest) agg.fastest = gap;
            if (gap > agg.slowest) agg.slowest = gap;
          }
          prevSender = sender;
          prevTime = sendTime;
        }
      }

      const last = batch.at(-1)!;
      cursor = { time: last.message.sendTime, rowId: last.rowId };
      if (batch.length < 500) break;
    }

    stats.activeDays = daily.size;

    // Mutual-active days → 火花 streak.
    const mutualDays: number[] = [];
    for (const day of selfDays) {
      if (peerDays.has(day)) mutualDays.push(day);
    }
    const streak = longestRun(mutualDays);

    const toReply = (a: typeof replyAgg.self): BuddyReplyStats | null =>
      a.count === 0
        ? null
        : {
            fastestSec: a.fastest === Infinity ? 0 : a.fastest,
            slowestSec: a.slowest,
            avgSec: Math.round(a.sum / a.count),
            count: a.count,
          };

    const timelineDaily = [...globalDaily.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const timelineWeekly = dailyToWeekly(timelineDaily);
    const weeks = hasRange
      ? buildWeekKeys(startTime ?? timelineFirst ?? 0, endTime ?? timelineLast ?? 0)
      : timelineWeekly.map((w) => w.weekStart);

    return {
      peer: { uid: peerUid, uin: peerUin },
      self: { uin: selfUin },
      statistics: stats,
      messageTypes,
      hourlySelf,
      hourlyPeer,
      daily: [...daily.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      timeline: {
        firstMessageTime: timelineFirst,
        lastMessageTime: timelineLast,
        daily: timelineDaily,
        weekly: timelineWeekly,
      },
      range: {
        startTime: startTime ?? null,
        endTime: endTime ?? null,
        defaulted,
      },
      weeks,
      weeklySelf: seriesForWeeks(weeks, weeklySelfCounts),
      weeklyPeer: seriesForWeeks(weeks, weeklyPeerCounts),
      initiation,
      reply: { self: toReply(replyAgg.self), peer: toReply(replyAgg.peer) },
      streak,
      phrasesSelf: topWords(phrasesSelf, 12),
      phrasesPeer: topWords(phrasesPeer, 12),
      emojisSelf: topEmojis(emojisSelf, 12),
      emojisPeer: topEmojis(emojisPeer, 12),
      wordCloud: [...wordCloud.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 150)
        .map(([word, count]) => ({ word, count })),
    };
  }

  /**
   * 全好友活跃度排行（近 N 天，days=0 为全部历史）。用一次 `GROUP BY 对方uid` 的
   * 聚合数出「每个好友的私聊总条数」，再用一次带 `senderUid=self` 的聚合数出「我发的」，
   * 相减得对方发的——**只两条 SQL、不扫消息体**，故可一次覆盖全部好友做排行。
   *
   * `window` 传显式 [startTime,endTime]（unix 秒）时忽略 days，直接按该窗口统计——
   * 供周报做「上一周」环比等任意区间查询复用同一套聚合。
   *
   * 返回按 total 降序、已解析昵称/备注的排行；`windowStart/windowEnd` 回传实际统计窗口
   * （unix 秒；全部历史时为 null），供上层如实说明覆盖范围。
   */
  async rankFriendsByActivity(
    days = 7,
    window?: { startTime: number; endTime: number },
  ): Promise<{
    windowStart: number | null;
    windowEnd: number | null;
    items: Array<{
      uid: string;
      uin: string;
      nick: string;
      remark: string;
      total: number;
      mine: number;
      peer: number;
    }>;
  }> {
    const now = Math.floor(Date.now() / 1000);
    const startTime = window ? window.startTime : days > 0 ? now - days * 86400 : undefined;
    const endTime = window ? window.endTime : days > 0 ? now : undefined;
    const selfUid = this.session.selfUid;

    // 全好友 uid（分页拉到底，避免漏人）。
    const uids: string[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.session.buddies.listBuddies(500, offset);
      if (page.length === 0) break;
      uids.push(...page.map((b) => b.uid));
      if (page.length < 500) break;
    }
    if (uids.length === 0) {
      return { windowStart: startTime ?? null, windowEnd: endTime ?? null, items: [] };
    }

    const db = this.session.c2cMsgs;
    const [totals, mineCounts] = await Promise.all([
      db.countByUids(uids, { startTime, endTime }),
      selfUid
        ? db.countByUids(uids, { startTime, endTime, senderUid: selfUid })
        : Promise.resolve({} as Record<string, number>),
    ]);

    // 只保留窗口内有过消息的好友，按 total 降序。
    const active = uids.filter((uid) => (totals[uid] ?? 0) > 0);
    const profiles = await this.session.profileInfo.profilesByUids(active);
    const profByUid = new Map(profiles.map((p) => [p.uid, p]));
    const items = active
      .map((uid) => {
        const total = totals[uid] ?? 0;
        const mine = Math.min(mineCounts[uid] ?? 0, total);
        const prof = profByUid.get(uid);
        return {
          uid,
          uin: String(this.session.uidMap.uinByUid(uid) ?? ''),
          nick: prof?.nick ?? '',
          remark: prof?.remark ?? '',
          total,
          mine,
          peer: total - mine,
        };
      })
      .sort((a, b) => b.total - a.total);

    return { windowStart: startTime ?? null, windowEnd: endTime ?? null, items };
  }
}
