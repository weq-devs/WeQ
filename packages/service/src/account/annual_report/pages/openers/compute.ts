import type { PageAvailability, ReportPageDefinition } from '../../types';
import { reportYearUnixRange } from '../../time';
import type { C2cInitiationTally } from '@weq/db';
import type { OpenerEntry, OpenersPageData } from './types';

/**
 * 「最接近一半」的可信门槛：一场两场不足以证明两个人「互相想到」，
 * 至少要有四场才谈得上倾向。榜上的另外两项则只要真的开口过就能进候选。
 */
const MIN_BALANCE_STARTS = 4;

/**
 * 谁先开口 —— 一份关于「人先想到人」的统计。
 *
 * 统计单位刻意不是消息：一段持续没超过 {@link CONVERSATION_GAP_SECONDS}
 * （静默 5 小时）的来往，无论中间说了几句，都只算一场「聊天」，而一场聊天
 * 只有一个先开口的人。把每一场记到先开口的那一侧，得到的是主动性的比例，
 * 而不是音量。
 *
 * 底层由 `C2cMsgDb.initiationTallies` 一次扫会话元数据完成（无正文解码），
 * 页面在这里只做三件事：汇总裁体的两方开场次数、挑三位有故事的人、补名字头像。
 */
export const openersPage: ReportPageDefinition<OpenersPageData> = {
  manifest: {
    id: 'openers',
    title: '谁先开口',
    description: '每场聊天都有一个先开口的人。这一年，谁先想到谁。',
    order: 5,
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
    const tallies = await q.c2c.initiationTallies(startSec, endSec);
    const candidates = tallies.filter(
      (tally) => tally.total > 0 && (tally.mine > 0 || tally.theirs > 0),
    );

    const peerCount = candidates.length;
    const selfStarts = candidates.reduce((sum, tally) => sum + tally.mine, 0);
    const peerStarts = candidates.reduce((sum, tally) => sum + tally.theirs, 0);
    const totalStarts = selfStarts + peerStarts;
    const selfRatio = totalStarts > 0 ? selfStarts / totalStarts : 0;

    // ── 三位朋友 ────────────────────────────────────────────────
    // 「你发起占比最高」按我的发起率排 —— 率才是一段关系里主动性的方向；
    // 次数在同样接近时做第二判据，并会写进页面文案让读者自己判断份量。
    const byMine = candidates
      .slice()
      .sort(
        (a, b) =>
          b.mine / b.total - a.mine / a.total ||
          b.total - a.total ||
          b.mine - a.mine ||
          a.peerUid.localeCompare(b.peerUid),
      );
    // 「TA 发起占比最高」同理，按对方发起率排。
    const byTheirs = candidates
      .slice()
      .sort(
        (a, b) =>
          b.theirs / b.total - a.theirs / a.total ||
          b.total - a.total ||
          b.theirs - a.theirs ||
          a.peerUid.localeCompare(b.peerUid),
      );
    // 「最接近一半」按 |我的比例 - 0.5| 排；同样接近时取聊得更久的那位。
    const byBalance = candidates
      .filter((tally) => tally.total >= MIN_BALANCE_STARTS && tally.mine > 0 && tally.theirs > 0)
      .sort((a, b) => {
        const diff = Math.abs(a.mine / a.total - 0.5) - Math.abs(b.mine / b.total - 0.5);
        return (
          diff ||
          b.total - a.total ||
          Math.abs(b.mine - b.theirs) - Math.abs(a.mine - a.theirs) ||
          a.peerUid.localeCompare(b.peerUid)
        );
      });

    const mostMineTally = byMine[0] ?? null;
    const mostPeerTally =
      byTheirs.find((tally) => tally.peerUid !== mostMineTally?.peerUid) ?? byTheirs[0] ?? null;
    const balancedTally =
      byBalance.find(
        (tally) =>
          tally.peerUid !== mostMineTally?.peerUid && tally.peerUid !== mostPeerTally?.peerUid,
      ) ??
      byBalance[0] ??
      null;

    const wantedUids = new Set<string>();
    if (mostMineTally) wantedUids.add(mostMineTally.peerUid);
    if (mostPeerTally) wantedUids.add(mostPeerTally.peerUid);
    if (balancedTally) wantedUids.add(balancedTally.peerUid);
    const profiles = await q.c2c.peerProfiles([...wantedUids]);
    const profileByUid = new Map(profiles.map((profile) => [profile.uid, profile]));
    const displayName = (uid: string): string => {
      const profile = profileByUid.get(uid);
      return profile?.remark || profile?.nick || `QQ ${(profile?.uin || uid).slice(-4)}`;
    };
    const entry = (tally: C2cInitiationTally): OpenerEntry => {
      const profile = profileByUid.get(tally.peerUid);
      return {
        peerUid: tally.peerUid,
        peerUin: profile?.uin ?? '',
        peerName: displayName(tally.peerUid),
        selfStarts: tally.mine,
        peerStarts: tally.theirs,
        totalStarts: tally.total,
        selfRatio: tally.total > 0 ? Math.round((tally.mine / tally.total) * 10000) / 10000 : 0,
      };
    };

    return {
      year,
      peerCount,
      totalStarts,
      selfStarts,
      peerStarts,
      selfRatio,
      mostMine: mostMineTally ? entry(mostMineTally) : null,
      balanced: balancedTally ? entry(balancedTally) : null,
      mostPeer: mostPeerTally ? entry(mostPeerTally) : null,
    };
  },
};
