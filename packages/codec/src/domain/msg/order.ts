interface OrderedMessage {
  msgSeq: string | bigint;
  sendTime?: string | bigint;
  msgId: string | bigint;
}

function numeric(value: string | bigint | undefined): bigint | null {
  if (typeof value === 'bigint') return value;
  return value !== undefined && /^-?\d+$/.test(value) ? BigInt(value) : null;
}

/** 与消息库排序一致：会话序号优先，同序号再按时间和真实 ID，不转 Number。 */
export function compareMessageOrder(a: OrderedMessage, b: OrderedMessage): number {
  for (const field of ['msgSeq', 'sendTime', 'msgId'] as const) {
    const left = numeric(a[field]);
    const right = numeric(b[field]);
    if (left === null || right === null) continue;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
