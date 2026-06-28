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
import type { C2cMsg, C2cPartition } from '@weq/db';
import { segmentWords } from './text_segment';

/** A silence longer than this splits two conversations (seconds). Replies that
 *  straddle a split are treated as a fresh initiation, not a reply — which is
 *  exactly how we avoid counting "orphan" replies to a message that actually
 *  ended the previous conversation. */
const CONVERSATION_GAP_SECONDS = 5 * 60 * 60;

export interface BuddyReplyStats {
  fastestSec: number;
  slowestSec: number;
  avgSec: number;
  count: number;
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
  daily: Array<{ date: string; count: number }>;
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

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Calendar day index (local) for streak adjacency checks. */
function dayIndex(dateStr: string): number {
  const parts = dateStr.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return Math.floor(new Date(y, m - 1, d).getTime() / 86400000);
}

function bumpEmoji(tally: EmojiTally, faceId: number, faceText: string): void {
  const key = String(faceId);
  const prev = tally.get(key);
  tally.set(key, { faceId, faceText: faceText || prev?.faceText || '', count: (prev?.count ?? 0) + 1 });
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

  async getBuddyAnalytics(peerUid: string): Promise<BuddyAnalytics> {
    const db = this.session.c2cMsgs;
    const part = this.c2cPartition(peerUid);
    const selfUin = String(this.session.context.uin ?? '');

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
    const selfDays = new Set<string>();
    const peerDays = new Set<string>();

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

    let afterSeq = 0n;
    while (true) {
      const batch: C2cMsg[] = await db.listAfter(part, afterSeq, 500);
      if (batch.length === 0) break;

      for (const msg of batch) {
        const isSelf = msg.senderUid !== peerUid;
        if (!isSelf && !peerUin && msg.senderUin > 0n) peerUin = String(msg.senderUin);
        if (!peerUin && msg.targetUin > 0n) peerUin = String(msg.targetUin);

        const sendTime = Number(msg.sendTime);
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
                bumpEmoji(isSelf ? emojisSelf : emojisPeer, faceId, el.faceText ? String(el.faceText) : '');
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
        if (sendTime > 0) {
          if (stats.firstMessageTime === null || sendTime < stats.firstMessageTime) {
            stats.firstMessageTime = sendTime;
          }
          if (stats.lastMessageTime === null || sendTime > stats.lastMessageTime) {
            stats.lastMessageTime = sendTime;
          }
          const d = new Date(sendTime * 1000);
          const hour = d.getHours();
          if (isSelf) hourlySelf[hour] = (hourlySelf[hour] ?? 0) + 1;
          else hourlyPeer[hour] = (hourlyPeer[hour] ?? 0) + 1;

          const key = ymd(d);
          daily.set(key, (daily.get(key) ?? 0) + 1);
          (isSelf ? selfDays : peerDays).add(key);

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

      afterSeq = batch[batch.length - 1]!.msgSeq;
      if (batch.length < 500) break;
    }

    stats.activeDays = daily.size;

    // Mutual-active days → 火花 streak.
    const mutualDays: number[] = [];
    for (const day of selfDays) {
      if (peerDays.has(day)) mutualDays.push(dayIndex(day));
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
}
