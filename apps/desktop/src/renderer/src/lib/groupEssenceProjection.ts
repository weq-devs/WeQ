import type { GroupEssenceWire } from '../components/GroupEssenceDialog';

export const GROUP_ESSENCE_ONLINE_LIMIT = 50;

export function hasCompleteEssenceSnapshot(input: {
  success: boolean;
  complete: boolean;
  updatedAt: number;
  localUpdatedAt: number;
}): boolean {
  return (
    input.success &&
    input.complete &&
    input.updatedAt > 0 &&
    input.updatedAt >= input.localUpdatedAt
  );
}

interface LocalEssence {
  msgSeq: number;
  msgRandom?: number;
  senderNick: string;
  operatorNick: string;
  timestamp: number;
  setStatus: number;
}
interface OnlineEssence {
  msgSeq: number;
  msgRandom?: number;
  senderNick: string;
  operatorNick: string;
  senderTime?: number;
  content?: GroupEssenceWire['content'];
  canRemove?: boolean;
}

function isoTime(seconds?: number): string {
  const date = new Date(Number(seconds ?? 0) * 1000);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/** 本地记录保留消息定位及取消状态；在线结果只补正文和本地尚未同步的新记录。 */
export function projectGroupEssence(
  local: readonly LocalEssence[],
  online: readonly OnlineEssence[],
  onlineComplete = false,
): GroupEssenceWire[] {
  const webBySeq = new Map(online.map((row) => [row.msgSeq, row]));
  const bySeq = new Map<number, GroupEssenceWire>();
  for (const item of local) {
    const web = webBySeq.get(item.msgSeq);
    bySeq.set(item.msgSeq, {
      id: `essence:${item.msgSeq}:${item.timestamp}`,
      msgSeq: item.msgSeq,
      msgRandom: item.msgRandom ?? web?.msgRandom,
      senderName: item.senderNick,
      operatorName: item.operatorNick,
      createdAt: isoTime(item.timestamp),
      active: onlineComplete ? web !== undefined : item.setStatus === 1,
      content: web?.content,
      senderTime: web?.senderTime,
      canRemove: web?.canRemove,
    });
  }
  for (const web of online) {
    if (bySeq.has(web.msgSeq)) continue;
    bySeq.set(web.msgSeq, {
      id: `essence:web:${web.msgSeq}:${web.senderTime ?? ''}`,
      msgSeq: web.msgSeq,
      msgRandom: web.msgRandom,
      senderName: web.senderNick,
      operatorName: web.operatorNick,
      createdAt: isoTime(web.senderTime),
      active: true,
      content: web.content,
      senderTime: web.senderTime,
      canRemove: web.canRemove,
    });
  }
  return [...bySeq.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}
