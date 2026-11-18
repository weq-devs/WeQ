import type { MessageBubbleSkin } from '@weq/service';
import { plainContentText } from '@weq/service/message-plain-text';
import { unixDate } from '@weq/time';
import type { DirectConversation, Message, User } from '../im-template/template/types';
import { client } from '../trpc/client';
import { readonlyConversationKind } from './conversationActions';
import { messageBubble, seedMessageBubbles } from './messageBubbles';

export type ReadonlyTarget =
  | { kind: 'official'; peerUid: string }
  | { kind: 'service'; appId: string }
  | { kind: 'guild'; nodeId: string };

export interface ReadonlyCursor {
  msgSeq: string;
  sendTime: string;
  msgId: string;
}

export interface ReadonlyWire extends ReadonlyCursor {
  cachedBubbles?: MessageBubbleSkin[];
  sendType?: string;
  senderUid?: string;
  senderUin?: string;
  elements?: unknown[];
  decoration?: { bubbleId: number; fontId: number; widgetId: number };
}

export function readonlyConversationTarget(
  conversation: DirectConversation,
): ReadonlyTarget | null {
  switch (readonlyConversationKind(conversation)) {
    case 'guild':
      return { kind: 'guild', nodeId: conversation.id.replace(/^guild:/, '') };
    case 'service':
      return { kind: 'service', appId: conversation.id.replace(/^service:/, '') };
    case 'official':
      return { kind: 'official', peerUid: conversation.otherUser.id };
    default:
      return null;
  }
}

/** 正式会话和预览共用倒序历史页；翻页使用来源支持的稳定锚点。 */
export async function readReadonlyOlderPage(
  target: ReadonlyTarget,
  binding: { expectedAccountUin?: string; expectedAccountConfigId?: string },
  cursor?: ReadonlyCursor | null,
): Promise<{ items: ReadonlyWire[]; hasMore: boolean; nextCursor: ReadonlyCursor | null }> {
  const limit = 50;
  if (target.kind !== 'guild') {
    const page = await client.account.readonlyConversationPage.query({
      ...binding,
      target,
      direction: 'older',
      cursor: cursor ?? undefined,
      limit,
    });
    if (!page.found) throw new Error('该条记录已不在当前会话中');
    return page;
  }
  const input = { ...binding, nodeId: target.nodeId, limit };
  const items = cursor
    ? await client.account.guildDirectBefore.query({
        ...input,
        beforeSeq: cursor.msgSeq,
        beforeMsgId: cursor.msgId,
      })
    : await client.account.guildDirectLatest.query({ ...input, stablePaging: true });
  const last = items.at(-1);
  return {
    items,
    hasMore: items.length === limit,
    nextCursor: last ? { msgId: last.msgId, msgSeq: last.msgSeq, sendTime: last.sendTime } : null,
  };
}

export function readonlyMessageText(elements?: unknown[]): string {
  return plainContentText(
    elements?.filter((element): element is { type: string } =>
      Boolean(
        element &&
          typeof element === 'object' &&
          'type' in element &&
          typeof element.type === 'string',
      ),
    ),
  );
}

export function readonlyConversationMessages(
  rows: readonly ReadonlyWire[],
  kind: ReadonlyTarget['kind'],
  conversation: DirectConversation,
  user: User,
): Message[] {
  for (const row of rows) seedMessageBubbles(row.cachedBubbles);
  return rows.map((row) => {
    const mine =
      kind === 'guild'
        ? row.sendType !== '0'
        : Boolean(row.senderUid && (row.senderUid === user.uid || row.senderUid === user.id)) ||
          Boolean(row.senderUin && row.senderUin === user.identityValue);
    const sender = mine ? user : conversation.otherUser;
    return {
      id: row.msgId,
      msgId: row.msgId,
      msgSeq: row.msgSeq,
      conversationId: conversation.id,
      body: readonlyMessageText(row.elements),
      senderId: sender.id,
      sender,
      createdAt: Number(row.sendTime) > 0 ? (unixDate(row.sendTime)?.toISOString() ?? '') : '',
      qqElements: row.elements as Message['qqElements'],
      decoration: row.decoration
        ? { ...row.decoration, cachedBubble: messageBubble(row.decoration.bubbleId) }
        : undefined,
    };
  });
}
