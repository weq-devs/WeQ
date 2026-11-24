export type FileSyncReceipt = { fileId: string; existingMsgIds: string[] };

type PendingFile = {
  id: string;
  convId: string;
  state: string;
  at: number;
  afterSeq?: string;
  fileSync?: FileSyncReceipt;
};

type SyncedFile = {
  msgId: string;
  msgSeq?: string;
  sendTime: string;
  elements: unknown[];
  sourceFormat?: 'native' | 'protocol';
  ntSeqVerified?: boolean;
};

/** 仅传入当前会话中自己发送的消息；文件发布回执没有 seq，改用服务端文件 ID 对账。 */
export function matchFileMessages(
  pending: readonly PendingFile[],
  messages: readonly SyncedFile[],
  convId: string,
  consumed: ReadonlyMap<string, string>,
  direct = false,
): Map<string, string> {
  const matches = new Map<string, string>();
  const used = new Set<string>();
  for (const item of pending) {
    if (item.convId !== convId || item.state !== 'sent' || !item.fileSync?.fileId) continue;
    const receipt = item.fileSync;
    const seenBefore = new Set(receipt.existingMsgIds);
    const floor = item.afterSeq && /^\d+$/.test(item.afterSeq) ? BigInt(item.afterSeq) : undefined;
    let match: SyncedFile | undefined;
    for (const message of messages) {
      const key = `${convId}:${message.msgId}`;
      if (used.has(key) || consumed.has(key) || seenBefore.has(message.msgId)) continue;
      const sameFile = message.elements.some((element) => {
        const el = element as { type?: string; data?: { fileToken?: unknown } } | null;
        return el?.type === 'file' && el.data?.fileToken === receipt.fileId;
      });
      if (!sameFile) continue;
      if (
        floor !== undefined &&
        message.msgSeq &&
        /^[1-9]\d*$/.test(message.msgSeq) &&
        (!direct || message.sourceFormat !== 'protocol' || message.ntSeqVerified)
      ) {
        if (BigInt(message.msgSeq) > floor) {
          match = message;
          break;
        }
        continue;
      }
      // 没有可信会话水位时，时间仍用于排除未加载到的旧文件消息。
      const time = Number(message.sendTime);
      if (!match && time > 0 && Number.isFinite(time) && time >= Math.floor(item.at / 1000))
        match = message;
    }
    if (!match) continue;
    const key = `${convId}:${match.msgId}`;
    used.add(key);
    matches.set(item.id, key);
  }
  return matches;
}
