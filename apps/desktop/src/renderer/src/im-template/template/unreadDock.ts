/**
 * 未读跳转坞 —— 打开会话时把 msg_unread_info_table 里的未读/高亮读进内存后，
 * 在会话右上角逐个引导用户跳转的那串「跳转点」。
 *
 * 规则（与产品约定一致）：
 *   1. 重要消息按 seq 从大到小排，右上角只显示下一个尚未查看的跳转点。
 *   2. 普通未读排在最后，跳到最早那条未读（已读水位 + 1）。
 *   3. 目标进入聊天视口、定位成功或点过确认缺失的提醒后，从队列移除。
 *
 * 本模块是纯函数（不依赖 React / service），便于单测与在模板层复用。
 */

import type {
  ConversationHighlight,
  ConversationHighlightKind,
  UnreadDock,
  UnreadDockStop,
} from './types';

export const IMPORTANT_MESSAGE_KINDS = [
  'atMe',
  'atAll',
  'replyMe',
  'specialCare',
  'groupKeyword',
  'newFile',
  'groupAnnouncement',
  'redPacket',
] as const satisfies readonly ConversationHighlightKind[];
export type ImportantMessageKind = (typeof IMPORTANT_MESSAGE_KINDS)[number];

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

/** 普通跳转定位打开时的起点，不代表当前还剩多少未读。 */
export function dockStopLabel(stop: UnreadDockStop): string {
  if (stop.kind === 'unread') return '跳到首条未读';
  const base = highlightLabel(stop.kind);
  // 群提醒词把命中的关键词一并显示，多个词才能区分开。
  if (stop.kind === 'groupKeyword' && stop.text) return `${base}「${stop.text}」`;
  return base;
}

/** 兜底未读点的色调永远是中性的「未读蓝」。 */
export function dockStopTone(stop: UnreadDockStop): HighlightTone {
  return stop.kind === 'unread' ? 'info' : highlightTone(stop.kind);
}

export function unreadHighlightKey(conversationId: string, stop: UnreadDockStop): string {
  return JSON.stringify([
    conversationId,
    stop.seq,
    stop.identity?.senderUid,
    stop.identity?.sendTime,
  ]);
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
 * 构造打开会话时的候选跳转点。
 *
 * @param highlights  48902 解出的高亮（可能为 undefined）
 * @param readSeq     已读到的 seq（41002）；第一条未读 = readSeq + 1
 * @param unread      打开会话时的未读总数（recent_contact 40003 − 41002）
 */
export function buildUnreadDock(input: {
  highlights: ConversationHighlight[] | null | undefined;
  readSeq?: string | number | null;
  unread: number;
}): UnreadDock | null {
  const unread = Math.max(0, Math.floor(input.unread));
  const read = toBig(input.readSeq);
  const hasRead = read > 0n;

  const firstUnread = read + 1n;
  // 同一 seq 命中多个类别时只保留一个跳转点（跳一次就够）。
  const bySeq = new Map<string, UnreadDockStop>();
  for (const highlight of input.highlights ?? []) {
    const seq = highlight.msgSeq;
    if (!seq) continue;
    // 同一 seq 命中多个类别时保留先到的那个（跳一次就够）。若其中有群提醒词，
    // 把命中的关键词挂上，让跳转坞显示「群提醒词·喵喵喵1」。
    const existing = bySeq.get(seq);
    const senderUid =
      highlight.senderUid && highlight.senderUid !== '0' ? highlight.senderUid : undefined;
    const sendTime =
      highlight.sendTime && /^[1-9]\d*$/.test(highlight.sendTime) ? highlight.sendTime : undefined;
    const identity =
      highlight.kind === 'newFile'
        ? { senderUid, sendTime, kind: 'newFile' as const }
        : senderUid || sendTime
          ? { senderUid, sendTime }
          : undefined;
    if (!existing)
      bySeq.set(seq, {
        kind: highlight.kind,
        seq,
        text: highlight.text,
        ...(identity ? { identity } : {}),
      });
    else if (highlight.kind === 'groupKeyword' && highlight.text) existing.text = highlight.text;
  }
  const stops: UnreadDockStop[] = Array.from(bySeq.values())
    .filter((stop) => !hasRead || toBig(stop.seq) > read)
    .sort(bySeqDesc);

  const firstUnreadSeq = hasRead && unread > 0 ? firstUnread.toString() : undefined;
  if (firstUnreadSeq && !stops.some((stop) => stop.seq === firstUnreadSeq))
    stops.push({ kind: 'unread', seq: firstUnreadSeq });

  if (stops.length === 0) return null;
  return firstUnreadSeq ? { stops, firstUnreadSeq } : { stops };
}
