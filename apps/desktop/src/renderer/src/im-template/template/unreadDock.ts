/**
 * 未读跳转坞 —— 打开会话时把 msg_unread_info_table 里的未读/高亮读进内存后，
 * 在会话右上角逐个引导用户跳转的那串「跳转点」。
 *
 * 规则（与产品约定一致）：
 *   1. 第一条未读已经落在首屏里（`read + 1 ≥ 首屏最小 seq`）⇒ 未读全看得见，
 *      整串跳转不显示。
 *   2. 否则把所有高亮（**不分类别**）混在一起按 seq 从大到小排，右上角**始终只显示
 *      一个**（最新的那条）；点掉它再显示下一个，依次类推。
 *   3. 高亮跳完还有普通未读时，最后补一个「新的 N 条未读消息」，跳到最早那条未读
 *      （已读水位 + 1）。
 *
 * 本模块是纯函数（不依赖 React / service），便于单测与在模板层复用。
 */

import type {
  ConversationHighlight,
  ConversationHighlightKind,
  UnreadDock,
  UnreadDockStop,
} from './types';

/** 高亮类别的中文标签（跳转坞与提示共用）。 */
const HIGHLIGHT_LABEL: Record<ConversationHighlightKind, string> = {
  atMe: '有人@我',
  atAll: '@全体成员',
  replyMe: '有人回复我',
  specialCare: '特别关心',
  groupKeyword: '群提醒词',
  newFile: '新文件',
  groupAnnouncement: '群公告',
  redPacket: '红包',
  unknown: '新消息',
};

/** 高亮类别的色调：告警类偏红、内容类偏蓝、红包偏金 —— 与会话列表保持一致。 */
export type HighlightTone = 'alert' | 'info' | 'gold';

const HIGHLIGHT_TONE: Record<ConversationHighlightKind, HighlightTone> = {
  atMe: 'alert',
  atAll: 'alert',
  replyMe: 'alert',
  specialCare: 'alert',
  groupKeyword: 'alert',
  unknown: 'alert',
  newFile: 'info',
  groupAnnouncement: 'info',
  redPacket: 'gold',
};

export function highlightLabel(kind: ConversationHighlightKind): string {
  return HIGHLIGHT_LABEL[kind] ?? '新消息';
}

export function highlightTone(kind: ConversationHighlightKind): HighlightTone {
  return HIGHLIGHT_TONE[kind] ?? 'alert';
}

/** 一个跳转点要显示的文案（兜底的未读用「新的 N 条未读消息」）。 */
export function dockStopLabel(stop: UnreadDockStop, unread: number): string {
  if (stop.kind === 'unread') return `新的 ${unread > 99 ? '99+' : unread} 条未读消息`;
  return highlightLabel(stop.kind);
}

/** 兜底未读点的色调永远是中性的「未读蓝」。 */
export function dockStopTone(stop: UnreadDockStop): HighlightTone {
  return stop.kind === 'unread' ? 'info' : highlightTone(stop.kind);
}

function toBig(value: string | number | undefined | null): bigint {
  try {
    return BigInt(value ?? '0');
  } catch {
    return 0n;
  }
}

/** 降序比较两个 seq（大的在前）。 */
function bySeqDesc(a: UnreadDockStop, b: UnreadDockStop): number {
  const av = toBig(a.seq);
  const bv = toBig(b.seq);
  return av === bv ? 0 : av > bv ? -1 : 1;
}

/**
 * 构造跳转点序列。返回 null 表示「首屏已经能看全，不需要引导」。
 *
 * @param highlights  48902 解出的高亮（可能为 undefined）
 * @param readSeq     已读到的 seq（41002）；第一条未读 = readSeq + 1
 * @param unread      打开会话时的未读总数（recent_contact 40003 − 41002）
 * @param visibleSeqs 首屏已加载出来的消息 seq 集合 —— 用于判断未读是否都在首屏内
 */
export function buildUnreadDock(input: {
  highlights: ConversationHighlight[] | null | undefined;
  readSeq?: string | number | null;
  unread: number;
  visibleSeqs: Iterable<string>;
}): UnreadDock | null {
  const unread = Math.max(0, Math.floor(input.unread));
  const read = toBig(input.readSeq);
  const hasRead = read > 0n;

  const visible = input.visibleSeqs instanceof Set ? input.visibleSeqs : new Set(input.visibleSeqs);
  const visibleNumbers = Array.from(visible)
    .map((seq) => toBig(seq))
    .filter((n) => n > 0n);
  const minVisible = visibleNumbers.length
    ? visibleNumbers.reduce((a, b) => (a < b ? a : b))
    : null;

  // 规则 1：已知已读水位、且第一条未读（read + 1）已落在首屏里 ⇒ 未读全看得见，
  //         整串跳转都不显示（产品要求「读到的 seq 在第一页里就不跳」）。
  if (hasRead && minVisible !== null && read + 1n >= minVisible) return null;

  // 规则 2：所有高亮混在一起，按 seq 从大到小排（最新的先跳）—— 不按类别分组。
  //         同一 seq 命中多个类别时只保留一个跳转点（跳一次就够）。
  const bySeq = new Map<string, UnreadDockStop>();
  for (const highlight of input.highlights ?? []) {
    const seq = highlight.msgSeq;
    if (!seq) continue;
    if (!bySeq.has(seq)) bySeq.set(seq, { kind: highlight.kind, seq });
  }
  const stops: UnreadDockStop[] = Array.from(bySeq.values())
    // 已读水位以内的命中（读过了）、以及已落在首屏里的命中（点了等于没动）都不引导。
    .filter((stop) => (!hasRead || toBig(stop.seq) > read) && !visible.has(stop.seq))
    .sort(bySeqDesc);

  // 规则 3：高亮跳完还有普通未读时，补一个「新的 N 条未读消息」，跳到最早那条未读。
  if (hasRead && unread > 0) {
    const firstUnread = (read + 1n).toString();
    if (!visible.has(firstUnread) && !stops.some((stop) => stop.seq === firstUnread)) {
      stops.push({ kind: 'unread', seq: firstUnread });
    }
  }

  if (stops.length === 0) return null;
  return { stops, unread };
}
