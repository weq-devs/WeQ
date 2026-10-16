import type { Conversation, Message, User } from '../im-template/template/types';
import { resolveMessageSender } from '../im-template/template/conversationDisplay';
import { displayUserName } from '../im-template/template/user';
import { previewNodes, previewNodesToText } from './conversationPreview';
import { selfIdentityValues } from './selfIdentity';

export interface SelectionModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/** Shift 以锚点选连续区间；Ctrl/⌘ + Shift 在原有选择上追加，其余点击切换单条。 */
export function selectMessageIds(
  current: ReadonlySet<string>,
  ordered: readonly string[],
  id: string,
  anchor: string | null,
  modifiers: SelectionModifiers = {},
): Set<string> {
  const next = new Set(
    modifiers.shiftKey && !modifiers.ctrlKey && !modifiers.metaKey ? [] : current,
  );
  if (modifiers.shiftKey) {
    const from = anchor === null ? -1 : ordered.indexOf(anchor);
    const to = ordered.indexOf(id);
    if (from >= 0 && to >= 0) {
      for (let index = Math.min(from, to); index <= Math.max(from, to); index++)
        next.add(ordered[index]!);
    } else next.add(id);
  } else if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function isLocalOutgoingMessage(message: Message): boolean {
  return Boolean(message.optimistic) || message.id.startsWith('optimistic-');
}

export function outgoingActionBlockReason(message: Message): string | null {
  if (!isLocalOutgoingMessage(message)) return null;
  if (message.optimistic === 'sending') return '消息仍在发送中';
  if (message.optimistic !== 'sent' || message.optimisticRejected) return '消息尚未确认发送成功';
  return null;
}

const timestamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function selectedMessagesText(
  messages: readonly Message[],
  conversation: Conversation,
  user: User,
): string {
  const self = new Set(selfIdentityValues(user));
  return messages
    .map((message) => {
      const sender = resolveMessageSender(message, conversation, user);
      const date = new Date(message.createdAt);
      const time = Number.isFinite(date.getTime()) ? timestamp.format(date) : '时间未知';
      const elements = (
        message as Message & {
          qqElements?: Array<{ type?: string; data?: Record<string, unknown> }>;
        }
      ).qqElements;
      const body = message.body?.trim()
        ? message.body
        : previewNodesToText(
            previewNodes(
              {
                previewElements: (Array.isArray(elements) ? elements : []).map((element) => ({
                  ...element?.data,
                  kind: element?.type,
                  displayText: element?.data?.faceText,
                })),
              },
              self,
            ),
          ) || '[消息]';
      return `${displayUserName(sender) || '未知发送者'} (${time})\n${body}`;
    })
    .join('\n\n');
}
