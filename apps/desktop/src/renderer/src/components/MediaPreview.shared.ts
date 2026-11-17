import { compareMessageOrder } from '@weq/codec';
import type { PreviewMedia } from './mediaPreviewTypes';

export function mergePreviewMedia(previous: PreviewMedia[], incoming: PreviewMedia[]) {
  const keys = new Set(previous.map((item) => item.key));
  const merged = [
    ...previous,
    ...incoming.filter((item) => !keys.has(item.key) && keys.add(item.key)),
  ];
  if (merged.every((item) => item.order)) {
    // 聊天沿用消息时间线的序号/时间/ID 排序；无序号的其他来源保留传入顺序。
    const groups = new Map<string, PreviewMedia[]>();
    for (const item of merged) {
      const group = groups.get(item.order!.messageId) ?? [];
      group.push(item);
      groups.set(item.order!.messageId, group);
    }
    return [...groups.values()]
      .sort((left, right) => {
        const a = left[0]!.order!,
          b = right[0]!.order!;
        return a.sequence !== undefined && b.sequence !== undefined
          ? compareMessageOrder(
              { msgSeq: a.sequence, sendTime: String(a.time), msgId: a.rawId ?? a.messageId },
              { msgSeq: b.sequence, sendTime: String(b.time), msgId: b.rawId ?? b.messageId },
            )
          : a.time - b.time;
      })
      .flatMap((group) => group.sort((a, b) => a.order!.element - b.order!.element));
  }
  return merged;
}
