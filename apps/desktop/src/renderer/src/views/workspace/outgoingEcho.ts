import { timelineRowKey } from '../../../../shared/roaming_timeline';
import { arkCardSignature } from '../../im-template/template/arkCards';
import { matchFileMessages } from '../../lib/fileSendReconcile';
import { matchGeneratedMessages } from '../../lib/generatedOutgoing';
import { matchForwardMessages, type LocalOutgoingRecord } from '../../lib/localOutgoing';
import type { MessageWire, OptimisticArk, OptimisticForward, OptimisticMessage } from './types';

function rowKey(convId: string, row: MessageWire) {
  return `row:${convId}:${timelineRowKey(row)}`;
}

function receiptKey(convId: string, row: MessageWire) {
  if (row.msgRandom && row.msgRandom !== '0' && row.msgSeq && row.msgSeq !== '0')
    return `receipt:${convId}:${row.msgSeq}:${row.msgRandom}`;
}

export function outgoingEchoKey(
  aliases: ReadonlyMap<string, string>,
  convId: string,
  row: MessageWire,
) {
  if (!aliases.size) return;
  const receipt = receiptKey(convId, row);
  return aliases.get(rowKey(convId, row)) ?? (receipt ? aliases.get(receipt) : undefined);
}

export function rememberOutgoingEcho(
  aliases: Map<string, string>,
  convId: string,
  row: MessageWire,
  outgoingId: string,
) {
  aliases.set(rowKey(convId, row), outgoingId);
  const receipt = receiptKey(convId, row);
  if (receipt) aliases.set(receipt, outgoingId);
  while (aliases.size > 1024) aliases.delete(aliases.keys().next().value!);
}

/** 输入仅含本人可显示的真实记录，匹配一次并让渲染和清理使用同一个结论。 */
export function matchOutgoingEchoes({
  convId,
  direct,
  rows,
  messages,
  arks,
  forwards,
  aliases,
}: {
  convId: string;
  direct: boolean;
  rows: readonly MessageWire[];
  messages: readonly OptimisticMessage[];
  arks: readonly OptimisticArk[];
  forwards: readonly OptimisticForward[];
  aliases: ReadonlyMap<string, string>;
}) {
  const candidates = new Map<string, MessageWire>();
  const consumed = new Map<string, string>();
  const byRandom = new Map<string, MessageWire>();
  const bySeq = new Map<string, MessageWire>();
  const matches = new Map<string, { row: MessageWire; confirmed: boolean }>();
  const pending: LocalOutgoingRecord[] = [...messages, ...arks, ...forwards].filter(
    (item) => item.convId === convId && item.state !== 'failed',
  );
  if (!pending.length) return matches;

  const keyOf = (row: MessageWire) => `${convId}:${row.msgId}`;
  for (const row of rows) {
    const key = keyOf(row);
    candidates.set(key, row);
    const outgoingId = outgoingEchoKey(aliases, convId, row);
    if (outgoingId) consumed.set(key, outgoingId);
    if (row.msgRandom && row.msgRandom !== '0') byRandom.set(row.msgRandom, row);
    if (
      row.msgSeq &&
      row.msgSeq !== '0' &&
      (!direct || row.sourceFormat !== 'protocol' || row.ntSeqVerified)
    )
      bySeq.set(row.msgSeq, row);
  }
  const claim = (item: LocalOutgoingRecord, row: MessageWire | undefined, confirmed = true) => {
    if (!row || matches.has(item.id)) return;
    const key = keyOf(row);
    const owner = consumed.get(key);
    if (owner && owner !== item.id) return;
    consumed.set(key, item.id);
    matches.set(item.id, { row, confirmed });
  };
  for (const item of pending) {
    const random = item.cid ?? item.requestRandom;
    if (random) claim(item, byRandom.get(random), item.state === 'sent');
  }
  for (const item of pending) {
    if (!item.seq || item.seqRejected) continue;
    const row = bySeq.get(item.seq);
    if (item.cid && row?.msgRandom && row.msgRandom !== '0' && row.msgRandom !== item.cid) continue;
    claim(item, row);
  }
  for (const item of arks) {
    if (
      item.convId !== convId ||
      item.state !== 'sent' ||
      !item.signature ||
      item.seqRejected ||
      matches.has(item.id)
    )
      continue;
    const row = rows.find(
      (row) =>
        !consumed.has(keyOf(row)) &&
        (!item.cid || !row.msgRandom || row.msgRandom === '0' || row.msgRandom === item.cid) &&
        Number(row.sendTime) >= Math.floor(item.at / 1000) - 1 &&
        row.elements.some((raw) => {
          const element = raw as { type?: string; data?: { arkData?: string } } | null;
          return (
            element?.type === 'ark' &&
            arkCardSignature(element.data?.arkData ?? '') === item.signature
          );
        }),
    );
    claim(item, row);
  }
  const unmatched = <T extends LocalOutgoingRecord>(items: readonly T[]) =>
    items.filter((item) => !matches.has(item.id));
  const remainingForwards = unmatched(forwards);
  if (remainingForwards.length) {
    const found = matchForwardMessages(remainingForwards, rows, convId, consumed);
    for (const item of remainingForwards) claim(item, candidates.get(found.get(item.id) ?? ''));
  }
  const remainingMessages = unmatched(messages);
  if (remainingMessages.length) {
    const files = matchFileMessages(remainingMessages, rows, convId, consumed);
    for (const item of remainingMessages) claim(item, candidates.get(files.get(item.id) ?? ''));
    const generated = matchGeneratedMessages(
      unmatched(remainingMessages),
      rows,
      convId,
      consumed,
      true,
    );
    for (const item of remainingMessages)
      claim(item, candidates.get(generated.get(item.id) ?? ''), !item.awaitingAiVoice);
  }
  return matches;
}
