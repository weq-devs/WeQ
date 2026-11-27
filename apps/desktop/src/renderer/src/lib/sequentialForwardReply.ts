import { plainContentText } from '@weq/service/message-plain-text';
import type { Message } from '../im-template/template/types';
import type { RepeatElement } from './messageRepeat';

export type ForwardChatKind = 'group' | 'c2c';

export type ForwardReceipt = {
  groupSequence?: number;
  privateSequence?: number;
  clientSequence?: number;
  timestamp?: number;
};

type ReplyTarget = {
  sequence: number;
  index?: number;
  senderUin?: number;
  time?: number;
};

export type ForwardReplyPrefix = {
  preview: RepeatElement;
  element: Record<string, unknown>;
};

type Source = {
  msgSeq?: string;
  clientSeq?: string;
  senderUid?: string;
  senderUin?: string;
  sendTime?: string;
};

function positive(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export function forwardReplyData(message: Message) {
  const elements = message.qqElements ?? [];
  const reply = elements.find(({ type }) => type === 'reply')?.data;
  if (
    reply &&
    !elements.some(
      ({ type, data }) =>
        type === 'file' || (type === 'markdown' && data?.flashTransferInfo != null),
    )
  )
    return reply;
}

export function forwardReplyLookup(kind: ForwardChatKind, data: Record<string, unknown>) {
  return {
    index: positive(kind === 'group' ? data.origMsgSeq : data.origMsgIndex),
    clientSeq:
      kind === 'c2c' ? (positive(data.origClientSeq) ?? positive(data.origMsgSeq)) : undefined,
    senderUin: positive(data.origSenderUin),
    sendTime: positive(data.origMsgTime),
  };
}

export function matchesForwardReply(
  kind: ForwardChatKind,
  data: Record<string, unknown>,
  source: Source,
): boolean {
  const { index, clientSeq, senderUin, sendTime } = forwardReplyLookup(kind, data);
  const senderUid = typeof data.origSenderUid === 'string' ? data.origSenderUid : '';
  if (senderUid && source.senderUid && senderUid !== source.senderUid) return false;
  const sourceUin = positive(source.senderUin);
  const sourceTime = positive(source.sendTime);
  if (senderUin && sourceUin && senderUin !== sourceUin) return false;
  if (sendTime && sourceTime && sendTime !== sourceTime) return false;
  if (kind === 'group') return index !== undefined && positive(source.msgSeq) === index;
  if (index && positive(source.msgSeq) !== index) return false;
  if (clientSeq && positive(source.clientSeq) !== clientSeq) return false;
  // 私聊发送方序号可在重启后复用，只凭作者和选区内的唯一性可能接错旧消息。
  return Boolean(
    index ||
      (clientSeq &&
        sendTime &&
        sendTime === sourceTime &&
        ((senderUid && senderUid === source.senderUid) || (senderUin && senderUin === sourceUin))),
  );
}

export function sequentialReplyTargets(messages: readonly Message[], kind?: ForwardChatKind) {
  const targets = new Map<string, string>();
  const replies = messages.flatMap((message) => {
    const data = forwardReplyData(message);
    return data ? [{ message, data }] : [];
  });
  if (!replies.length) return targets;

  const bySeq = new Map<number, Message[]>();
  const byClientSeq = new Map<number, Message[]>();
  const ids = new Set(messages.map(({ id }) => id));
  for (const message of messages) {
    if (message.forwardSnapshot || message.optimistic) continue;
    for (const [index, raw] of [
      [bySeq, message.msgSeq],
      [byClientSeq, message.clientSeq],
    ] as const) {
      const seq = positive(raw);
      if (!seq) continue;
      const matches = index.get(seq);
      if (matches) matches.push(message);
      else index.set(seq, [message]);
    }
  }
  for (const { message, data } of replies) {
    if (message.forwardSnapshot) {
      const id = message.forwardSnapshot.replyTargetId;
      if (id && ids.has(id)) targets.set(message.id, id);
      continue;
    }
    if (!kind) continue;
    const { index, clientSeq } = forwardReplyLookup(kind, data);
    const candidates = index ? bySeq.get(index) : byClientSeq.get(clientSeq ?? 0);
    const matches = candidates?.filter(
      (source) =>
        source.id !== message.id &&
        source.conversationId === message.conversationId &&
        matchesForwardReply(kind, data, {
          ...source,
          senderUid: source.senderUid ?? source.sender?.uid,
          senderUin: source.sender?.identityValue,
          sendTime: source.sendTime ?? String(Math.floor(Date.parse(source.createdAt) / 1000)),
        }),
    );
    if (matches?.length === 1) targets.set(message.id, matches[0]!.id);
  }
  return targets;
}

function forwardedReplyTarget(kind: ForwardChatKind, receipt: ForwardReceipt, uin: string) {
  const index = positive(kind === 'group' ? receipt.groupSequence : receipt.privateSequence);
  const sequence = kind === 'group' ? index : positive(receipt.clientSequence);
  if (sequence)
    return { sequence, index, senderUin: positive(uin), time: positive(receipt.timestamp) };
}

export function originalForwardReplyTarget(kind: ForwardChatKind, source: Source) {
  const index = positive(source.msgSeq);
  const sequence = kind === 'group' ? index : positive(source.clientSeq);
  if (sequence)
    return {
      sequence,
      index,
      senderUin: positive(source.senderUin),
      time: positive(source.sendTime),
    };
}

export async function resolveForwardReplyPrefix({
  data,
  kind,
  uin,
  receipt,
  includeExcerpt,
  original,
}: {
  data: Record<string, unknown>;
  kind: ForwardChatKind;
  uin: string;
  receipt?: ForwardReceipt;
  includeExcerpt: boolean;
  original?: () => Promise<ReplyTarget | undefined>;
}): Promise<ForwardReplyPrefix | undefined> {
  const forwarded = receipt && forwardedReplyTarget(kind, receipt, uin);
  const target = forwarded ?? (await original?.());
  return forwardReplyPrefix(data, target, includeExcerpt);
}

function forwardReplyPrefix(
  data: Record<string, unknown>,
  target: ReplyTarget | undefined,
  includeExcerpt: boolean,
): ForwardReplyPrefix | undefined {
  const summary = plainContentText(
    Array.isArray(data.origElements) ? data.origElements.filter((el) => el?.type !== 'reply') : [],
    String(data.origText ?? data.replyTextSummary ?? ''),
  ).trim();
  if (target) {
    const textContent = summary || '[消息]';
    return {
      element: {
        kind: 'reply',
        origMsgSeq: target.sequence,
        origSenderUin: target.senderUin,
        origMsgTime: target.time,
        origElements: [{ kind: 'text', textContent }],
      },
      preview: {
        type: 'reply',
        data: {
          origMsgSeq: target.sequence,
          origClientSeq: target.sequence,
          origMsgIndex: target.index,
          origSenderUin: target.senderUin,
          origMsgTime: target.time,
          origElements: [{ type: 'text', data: { textContent } }],
        },
      },
    };
  }
  if (!includeExcerpt || !summary) return;
  const textContent = `${summary
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n`;
  return {
    element: { kind: 'text', textContent },
    preview: { type: 'text', data: { textContent } },
  };
}
