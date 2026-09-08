import type { PageAvailability, PageComputeCtx, ReportPageDefinition } from '../../types';
import { reportYearUnixRange } from '../../time';
import type {
  InteractionsEcho,
  InteractionsGroupTop,
  InteractionsPageData,
  InteractionsPerson,
} from './types';

/**
 * 群聊互动 —— 一页关于热闹的四件小事：
 *
 *   - 伸手（我发起的戳一戳）
 *   - 点名（我发出的 @）
 *   - 名字回来找我（别人 @ 我最多的群）
 *   - 齐声（复读：跟了多少轮、最长在哪一页）
 *
 * 数据只扫一次：`q.group.interactionTally` 在 db 层逐群解码正文并当场聚合，这里只
 * 给冠军补群名和成员名。群名、人名都允许缺失 —— 页面退到群号 / 消息自带名字，
 * 不为了统计中断一次取名。
 */
export const interactionsPage: ReportPageDefinition<InteractionsPageData> = {
  manifest: {
    id: 'interactions',
    title: '群聊互动',
    description: '戳一戳、@、被点名与复读——热闹的证据，都在这儿。',
    order: 9,
    version: '0.1.0',
    apiVersion: 1,
    category: '群聊',
    enabledByDefault: true,
  },
  availability: async ({ year, q }): Promise<PageAvailability> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const counts = await q.overview.countByDirection(startSec, endSec);
    const hasGroup = counts.groupSent > 0 || counts.groupReceived > 0;
    return {
      available: hasGroup,
      reason: hasGroup ? undefined : '这段时间没有可统计的群聊记录',
    };
  },
  compute: async ({ year, q }): Promise<InteractionsPageData> => {
    const { startSec, endSec } = reportYearUnixRange(year);
    const tally = await q.group.interactionTally(startSec, endSec);

    const wantedCodes = new Set<string>();
    for (const top of [tally.poke.top, tally.at.top]) {
      if (top?.groupCode) wantedCodes.add(top.groupCode);
    }
    if (tally.atMe.topGroup) wantedCodes.add(tally.atMe.topGroup.groupCode);
    if (tally.echo.longest) wantedCodes.add(tally.echo.longest.groupCode);

    const details = await q.group.details([...wantedCodes]);
    const groupNameOf = new Map<string, string>();
    for (const group of details) groupNameOf.set(group.groupCode, group.groupName);

    const [pokeTop, atTop] = await Promise.all([
      personWithName(q, tally.poke.top, groupNameOf),
      personWithName(q, tally.at.top, groupNameOf),
    ]);

    return {
      year,
      pokeTotal: tally.poke.total,
      pokeTop,
      atTotal: tally.at.total,
      atTop,
      atMeTotal: tally.atMe.total,
      atMeTop: groupTop(tally.atMe.topGroup, groupNameOf),
      echoParticipated: tally.echo.participatedRuns,
      echoLongest: echoWithGroup(tally.echo.longest, groupNameOf),
    };
  },
};

/** 给“人”补名字：群成员表的群名片优先，其次消息自带的名字，最后才是尾号兜底。 */
async function personWithName(
  q: PageComputeCtx['q'],
  top: {
    targetUid: string;
    targetUin: string;
    groupCode: string;
    count: number;
    displayName: string;
  } | null,
  groupNameOf: Map<string, string>,
): Promise<InteractionsPerson | null> {
  if (!top) return null;
  let name = '';
  try {
    if (top.groupCode && (top.targetUid || top.targetUin)) {
      const members = await q.group.memberBriefs(
        top.groupCode,
        top.targetUid ? [top.targetUid] : [],
        top.targetUin ? [top.targetUin] : [],
      );
      const member = members[0];
      const memberName = member
        ? String(member.card ?? '').trim() || String(member.nick ?? '').trim()
        : '';
      name = memberName;
    }
  } catch {
    name = '';
  }
  if (!name) name = top.displayName;
  if (!name) {
    name = top.targetUin ? `尾号 ${top.targetUin.slice(-4)}` : '某位群友';
  }
  return {
    uid: top.targetUid,
    uin: top.targetUin,
    name,
    groupCode: top.groupCode,
    groupName: groupNameOf.get(top.groupCode) ?? top.groupCode,
    count: top.count,
  };
}

function groupTop(
  top: { groupCode: string; count: number } | null,
  groupNameOf: Map<string, string>,
): InteractionsGroupTop | null {
  if (!top) return null;
  return {
    groupCode: top.groupCode,
    groupName: groupNameOf.get(top.groupCode) ?? top.groupCode,
    count: top.count,
  };
}

function echoWithGroup(
  top: { groupCode: string; count: number; text: string } | null,
  groupNameOf: Map<string, string>,
): InteractionsEcho | null {
  if (!top) return null;
  return {
    groupCode: top.groupCode,
    groupName: groupNameOf.get(top.groupCode) ?? top.groupCode,
    count: top.count,
    text: top.text,
  };
}
