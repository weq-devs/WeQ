export type FileSyncReceipt = { fileId: string; existingMsgIds: string[] };

type PendingFile = {
  id: string;
  convId: string;
  state: string;
  at: number;
  fileSync?: FileSyncReceipt;
};

type SyncedFile = { msgId: string; sendTime: string; elements: unknown[] };

/** 仅传入当前会话中自己发送的消息；文件发布回执没有 seq，改用服务端文件 ID 对账。 */
export function matchFileMessages(
  pending: readonly PendingFile[],
  messages: readonly SyncedFile[],
  convId: string,
  consumed: ReadonlyMap<string, string>,
): Map<string, string> {
  const matches = new Map<string, string>();
  const used = new Set<string>();
  for (const item of pending) {
    if (item.convId !== convId || item.state !== 'sent' || !item.fileSync?.fileId) continue;
    const receipt = item.fileSync;
    const match = messages.find((message) => {
      const key = `${convId}:${message.msgId}`;
      if (used.has(key) || consumed.has(key) || receipt.existingMsgIds.includes(message.msgId))
        return false;
      const time = Number(message.sendTime);
      if (!message.sendTime || !Number.isFinite(time) || time < Math.floor(item.at / 1000))
        return false;
      return message.elements.some((element) => {
        const el = element as { type?: string; data?: { fileToken?: unknown } } | null;
        return el?.type === 'file' && el.data?.fileToken === receipt.fileId;
      });
    });
    if (!match) continue;
    const key = `${convId}:${match.msgId}`;
    used.add(key);
    matches.set(item.id, key);
  }
  return matches;
}
