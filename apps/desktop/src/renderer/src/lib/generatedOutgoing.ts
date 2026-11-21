import { parseFlashShareCode } from './flashShare';
import { voiceFileHash } from '../../../shared/roaming_timeline';

type Row = { msgId: string; sendTime: string; elements: readonly unknown[] };
type Pending = {
  id: string;
  convId: string;
  state: string;
  at: number;
  signatures?: string[];
  awaitingAiVoice?: boolean;
  generatedExistingMsgIds?: string[];
};

function signaturesOf(row: Row): string[] {
  const result: string[] = [];
  for (const raw of row.elements) {
    const el = raw as { type?: string; data?: Record<string, unknown> } | null;
    if (!el) continue;
    if (el.type === 'markdown') {
      const info = el.data?.flashTransferInfo as { fileSetId?: string } | undefined;
      if (info?.fileSetId) result.push(`flash:${info.fileSetId}`);
    }
    if (el.type === 'text') {
      const code = parseFlashShareCode(String(el.data?.textContent ?? ''));
      if (code) result.push(`flash:${code}`);
    }
    if (el.type === 'ptt' && el.data?.isAiVoice) result.push(`aiVoice:${voiceFileHash(el.data)}`);
  }
  return result;
}

/** 调用方只提供本人真消息；同文旧消息和已消费回声不能收掉新的本地预览。 */
export function matchGeneratedMessages(
  pending: readonly Pending[],
  rows: readonly Row[],
  convId: string,
  consumed: ReadonlyMap<string, string>,
  includeUnconfirmedAi = false,
): Map<string, string> {
  const matches = new Map<string, string>();
  if (
    !pending.some(
      (item) =>
        item.convId === convId &&
        item.state !== 'failed' &&
        (item.signatures?.length || (includeUnconfirmedAi && item.awaitingAiVoice)),
    )
  )
    return matches;
  const used = new Set<string>();
  const candidates = rows.map((row) => ({
    row,
    key: `${convId}:${row.msgId}`,
    signatures: signaturesOf(row),
  }));
  // 先认有回执的发送；正在发送的占位只供渲染临时隐藏，等回执再确认并移除。
  const queue = includeUnconfirmedAi
    ? [
        ...pending.filter((item) => !item.awaitingAiVoice),
        ...pending.filter((item) => item.awaitingAiVoice),
      ]
    : pending;
  for (const item of queue) {
    if (item.convId !== convId || item.state === 'failed') continue;
    const unconfirmed = includeUnconfirmedAi && item.awaitingAiVoice && item.state === 'sending';
    if (!unconfirmed && !item.signatures?.length) continue;
    const existing = new Set(item.generatedExistingMsgIds);
    const candidate = candidates.find(
      ({ row, key, signatures }) =>
        !existing.has(row.msgId) &&
        !used.has(key) &&
        (!consumed.has(key) || consumed.get(key) === item.id) &&
        Number(row.sendTime) >= Math.floor(item.at / 1000) - 1 &&
        signatures.some((signature) =>
          unconfirmed ? signature.startsWith('aiVoice:') : item.signatures?.includes(signature),
        ),
    );
    if (candidate) {
      used.add(candidate.key);
      matches.set(item.id, candidate.key);
    }
  }
  return matches;
}
