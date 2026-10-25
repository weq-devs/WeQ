import type { Conversation, User } from '../im-template/template/types';
import { previewNodes, previewNodesToText, type PreviewNode } from './conversationPreview';
import type { LocalOutgoingRecord } from './localOutgoing';

export interface OutgoingPreviewRecord extends LocalOutgoingRecord {
  at: number;
  body?: string;
  elements?: readonly unknown[];
  title?: string;
  arkData?: string;
}

export interface RecentOutgoingSummary {
  targetUid: string;
  msgSeq?: string;
  sendTime: string;
}

interface OutgoingPreviewContent extends LocalOutgoingRecord {
  at: number;
  body: string;
  nodes: PreviewNode[];
}

interface OutgoingConversationPreview extends OutgoingPreviewContent {
  lastSent?: OutgoingPreviewContent;
}

export type OutgoingConversationPreviews = ReadonlyMap<string, OutgoingConversationPreview>;

function recordPreview(item: OutgoingPreviewRecord): OutgoingPreviewContent {
  const elements = (item.elements ?? []).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const element = raw as { type?: string; data?: Record<string, unknown> };
    return [
      {
        ...element.data,
        kind: element.type === 'at' ? 'text' : element.type,
        displayText: element.data?.faceText,
        markdownContent49099: element.data?.markdownContent,
      },
    ];
  });
  const nodes = previewNodes({ previewElements: elements });
  const body =
    previewNodesToText(nodes) ||
    item.body ||
    (item.title ? `[合并转发] ${item.title}` : item.arkData ? '[卡片消息]' : '[消息]');
  // 只保存摘要和对账键，不延长本地图片、音频和输入草稿的生命周期。
  return {
    id: item.id,
    convId: item.convId,
    state: item.state,
    at: item.at,
    seq: item.seq,
    afterSeq: item.afterSeq,
    seqRejected: item.seqRejected,
    body,
    nodes: nodes.length ? nodes : [{ t: 'text', text: body }],
  };
}

const sequence = (value?: string) => (value && /^\d+$/.test(value) ? BigInt(value) : 0n);

function summaryCaughtUp(item: OutgoingConversationPreview, recent?: RecentOutgoingSummary) {
  if (!recent) return false;
  const time = Number(recent.sendTime);
  const second = Math.floor(item.at / 1000);
  if (time > second) return true;
  if (time < second) return false;
  if (item.state === 'sent' && !item.seqRejected && sequence(item.seq) > 0n)
    return sequence(recent.msgSeq) >= sequence(item.seq);
  return (
    item.state === 'failed' &&
    item.afterSeq !== undefined &&
    sequence(recent.msgSeq) > sequence(item.afterSeq)
  );
}

/** 气泡对账和最近会话读取可先后到达；已发摘要保留到最近会话追上，失败摘要随占位移除。 */
export function updateOutgoingConversationPreviews(
  previous: OutgoingConversationPreviews,
  records: readonly OutgoingPreviewRecord[],
  recent: readonly RecentOutgoingSummary[],
): OutgoingConversationPreviews {
  const summaries = new Map(recent.map((row) => [row.targetUid, row]));
  const next = new Map<string, OutgoingConversationPreview>();
  const sent = new Map<string, OutgoingPreviewContent>();
  for (const [id, item] of previous) {
    const confirmed = item.state === 'sent' && !item.seqRejected ? item : item.lastSent;
    if (confirmed && !summaryCaughtUp(confirmed, summaries.get(id))) {
      sent.set(id, confirmed);
      next.set(id, confirmed);
    }
  }
  for (const record of records) {
    if (!Number.isFinite(record.at)) continue;
    const item = recordPreview(record);
    if (summaryCaughtUp(item, summaries.get(item.convId))) continue;
    if (item.state === 'sent' && !item.seqRejected && item.at >= (sent.get(item.convId)?.at ?? 0))
      sent.set(item.convId, item);
    const current = next.get(item.convId);
    if (!current || item.at >= current.at) next.set(item.convId, item);
  }
  for (const [id, item] of next) {
    if (item.state !== 'sent' || item.seqRejected)
      next.set(id, { ...item, lastSent: sent.get(id) });
  }
  return next;
}

export function applyOutgoingConversationPreview(
  conversation: Conversation,
  previews: OutgoingConversationPreviews,
  user: User,
): Conversation {
  const item = previews.get(conversation.id);
  if (!item || conversation.type === 'merged') return conversation;
  const status =
    item.state === 'queued'
      ? '[排队中] '
      : item.state === 'sending'
        ? '[发送中] '
        : item.state === 'failed'
          ? '[发送失败] '
          : item.seqRejected
            ? '[可能未送达] '
            : '';
  const createdAt = new Date(item.at).toISOString();
  return {
    ...conversation,
    updatedAt: new Date(Math.max(Date.parse(conversation.updatedAt) || 0, item.at)).toISOString(),
    lastMessage: {
      id: item.id,
      senderId: user.id,
      senderDisplayName: user.displayName,
      body: `${status}${item.body}`,
      previewNodes: status ? [{ t: 'text', text: status }, ...item.nodes] : item.nodes,
      createdAt,
    },
  };
}
