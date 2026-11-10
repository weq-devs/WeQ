import type { DressService, MessageBubbleSkin } from '@weq/service';

export interface MessageBubbleCarrier {
  decoration?: { bubbleId: number };
  cachedBubbles?: MessageBubbleSkin[];
  subMsgs?: MessageBubbleCarrier[];
}

/** 热路径只查内存；每页同款底图只随第一条记录传一次。 */
export function withMessageBubbles<T>(
  rows: T[],
  dress: Pick<DressService, 'messageBubble'> | undefined,
): T[] {
  if (!dress?.messageBubble || !rows.length) return rows;
  const skins = new Map<number, MessageBubbleSkin>();
  const seen = new Set<number>();
  const visit = (items: unknown[]) => {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const row = item as MessageBubbleCarrier;
      const id = row.decoration?.bubbleId;
      if (id && !seen.has(id)) {
        seen.add(id);
        const skin = dress.messageBubble(id);
        if (skin) skins.set(id, skin);
      }
      if (row.subMsgs) visit(row.subMsgs);
    }
  };
  visit(rows);
  if (!skins.size) return rows;
  const first = rows[0] as MessageBubbleCarrier;
  if (
    first.cachedBubbles?.length === skins.size &&
    first.cachedBubbles.every((skin) => skins.get(skin.itemId) === skin)
  )
    return rows;
  return rows.map((row, index) => {
    if (index === 0) return Object.assign({}, row, { cachedBubbles: [...skins.values()] });
    return row && typeof row === 'object' && 'cachedBubbles' in row
      ? Object.assign({}, row, { cachedBubbles: undefined })
      : row;
  });
}
