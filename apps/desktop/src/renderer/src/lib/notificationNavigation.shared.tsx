import { createContext, type ReactNode } from 'react';
import type { AppSearchTarget } from '../components/search/appSearchCatalog';
import type { MfTarget } from '../components/mergeForward/model';
import type { QzoneCardTarget } from './qzoneNavigation';
import type { GroupResourceRequest } from '../hooks/useGroupResourceWindows';
import type { GroupWorkspaceTab, ContactWorkspaceTab } from './profileNavigation';
import type { Message } from '../im-template/template/types';
import { accountBinding } from './clientPreferences';
import { IS_WEB } from './target.shared';
import type { GeneratedReply } from '../../../shared/generated_reply';

export type NotificationTarget =
  | { kind: 'app'; target: AppSearchTarget; recordId?: string }
  | {
      kind: 'conversation';
      conversationKind: 'c2c' | 'group' | 'dataline';
      conv: string;
      seq?: string;
      msgId?: string;
    }
  | {
      kind: 'forwarded-conversations';
      targets: readonly MfTarget[];
      binding: NonNullable<ReturnType<typeof accountBinding>>;
    }
  | { kind: 'mail'; folderId?: number; mailId: string }
  | { kind: 'task'; id: string }
  | { kind: 'contact'; id: string; tab?: ContactWorkspaceTab }
  | { kind: 'group'; id: string; section?: GroupWorkspaceTab }
  | { kind: 'contact-notice'; notice: 'friend' | 'group' }
  | { kind: 'assistant' }
  | ({ kind: 'generated-reply'; conversationKind: GeneratedReply['kind'] } & Pick<
      GeneratedReply,
      'conversationId' | 'messageId'
    >)
  | { kind: 'qzone'; target: QzoneCardTarget }
  | { kind: 'group-resource'; request: Omit<GroupResourceRequest, 'onJumpToMessage'> }
  | { kind: 'local'; open: () => unknown };

export interface NotificationSource {
  label: string;
  target: NotificationTarget;
  binding: ReturnType<typeof accountBinding>;
}

const NAVIGATE = 'weq:notification-navigate';
const notificationSourceContext = createContext<NotificationSource | null>(null);

export function notificationSource(
  target: NotificationTarget,
  label = '定位通知来源',
  binding = accountBinding(),
): NotificationSource {
  return { target, label, binding: binding ? { ...binding } : null };
}

export function notificationContent(source: NotificationSource | null, children: ReactNode) {
  return (
    <notificationSourceContext.Provider value={source}>
      {children}
    </notificationSourceContext.Provider>
  );
}

export function restoreNotificationSource<T>(
  value: T,
  restore: (value: T) => void,
  label = '返回通知来源',
) {
  return notificationSource({ kind: 'local', open: () => restore(value) }, label);
}

export function conversationNotificationSource(
  conversation: { id: string; type: string } | null | undefined,
) {
  return notificationSource(
    conversation
      ? {
          kind: 'conversation',
          conversationKind:
            conversation.type === 'group'
              ? 'group'
              : conversation.type === 'dataline'
                ? 'dataline'
                : 'c2c',
          conv: conversation.id,
        }
      : { kind: 'app', target: { kind: 'view', view: 'messages' } },
    '返回对应会话',
  );
}

export function taskNotificationSource(id: string, prefix = 'export') {
  return notificationSource({ kind: 'task', id: `${prefix}:${id}` }, '查看这项任务');
}

export function messageNotificationSource(
  conversation: { id: string; type: string },
  message: Pick<Message, 'id' | 'msgSeq' | 'sourceFormat' | 'ntSeqVerified'>,
  binding = accountBinding(),
) {
  return notificationSource(
    {
      kind: 'conversation',
      conversationKind: conversation.type === 'group' ? 'group' : 'c2c',
      conv: conversation.id,
      msgId: message.id,
      seq:
        message.sourceFormat === 'protocol' && !message.ntSeqVerified ? undefined : message.msgSeq,
    },
    '定位这条消息',
    binding,
  );
}

export function savedFileNotificationSource(path: string | null | undefined) {
  if (!path || IS_WEB) return undefined;
  return notificationSource(
    {
      kind: 'local',
      open: async () => {
        const { client } = await import('../trpc/client');
        const result = await client.help.openFolder.mutate({ path });
        if (!result.ok) throw new Error(result.error || '无法打开保存结果');
      },
    },
    '查看保存结果',
    null,
  );
}

export function openNotificationSource(source: NotificationSource): unknown {
  const current = accountBinding();
  if (
    source.binding &&
    (current?.expectedAccountUin !== source.binding.expectedAccountUin ||
      current.expectedAccountConfigId !== source.binding.expectedAccountConfigId)
  )
    throw new Error('请先切回通知来源账号及原数据源');
  if (source.target.kind === 'local') return source.target.open();
  window.focus();
  window.dispatchEvent(new CustomEvent(NAVIGATE, { detail: source.target }));
}

export function onNotificationNavigation(handle: (target: NotificationTarget) => void) {
  const receive = (event: Event) => handle((event as CustomEvent<NotificationTarget>).detail);
  window.addEventListener(NAVIGATE, receive);
  return () => window.removeEventListener(NAVIGATE, receive);
}

export { notificationSourceContext as NotificationSourceContext };
