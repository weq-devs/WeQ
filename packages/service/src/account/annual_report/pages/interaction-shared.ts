/**
 * 群聊互动三页（@ 与被 @ / 戳一戳 / 复读）共用的数据形状与取名工具。
 *
 * 三页来自同一次 `q.group.interactionTally` 扫描，各自的 compute 只把「自己那一组」
 * 收口成页面契约，取名逻辑（群成员表 > 消息自带名 > 尾号兜底）完全一致，因此收在
 * 这里，避免三份拷贝慢慢跑偏。
 */
import type { PageComputeCtx } from '../types';

/** 被戳/被 @ 最多的人。名字已由 compute 解析为最终展示名。 */
export type InteractionsPerson = {
  /** NT uid；老记录可能只有 QQ 号。 */
  uid: string;
  /** QQ 号（十进制字符串），不一定有。 */
  uin: string;
  name: string;
  /** 这段互动主要发生的群。 */
  groupCode: string;
  groupName: string;
  count: number;
};

/** 某个群的一项聚合（被 @ 最多的群）。 */
export type InteractionsGroupTop = {
  groupCode: string;
  groupName: string;
  count: number;
};

/** 最长复读的落点。 */
export type InteractionsEcho = {
  groupCode: string;
  groupName: string;
  count: number;
  /** 被反复发的那句原文。 */
  text: string;
};

/** 给“人”补名字：群成员表的群名片优先，其次消息自带的名字，最后才是尾号兜底。 */
export async function personWithName(
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

export function groupTop(
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

export function echoWithGroup(
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

/**
 * 把 tally 里涉及的冠军群批量取一次群名，返回 groupCode → groupName 的字典。
 * 查不到的群由调用方用群号兜底（`groupNameOf.get(code) ?? code`）。
 */
export async function loadGroupNames(
  q: PageComputeCtx['q'],
  codes: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const wanted = new Set<string>();
  for (const code of codes) {
    if (code) wanted.add(code);
  }
  const details = await q.group.details([...wanted]);
  const map = new Map<string, string>();
  for (const group of details) map.set(group.groupCode, group.groupName);
  return map;
}
