import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AppSearchTarget } from '../components/search/appSearchCatalog';
import type { QzoneCardTarget } from './qzoneNavigation';
import type { GroupResourceRequest } from '../hooks/useGroupResourceWindows';
import type { GroupWorkspaceTab, ContactWorkspaceTab } from './profileNavigation';
import type { Message } from '../im-template/template/types';
import { accountBinding } from './clientPreferences';
import { IS_WEB } from './target';

export type NotificationTarget =
  | { kind: 'app'; target: AppSearchTarget; recordId?: string }
  | {
      kind: 'conversation';
      conversationKind: 'c2c' | 'group' | 'dataline';
      conv: string;
      seq?: string;
      msgId?: string;
    }
  | { kind: 'mail'; folderId: number; mailId: string }
  | { kind: 'task'; id: string }
  | { kind: 'contact'; id: string; tab?: ContactWorkspaceTab }
  | { kind: 'group'; id: string; section?: GroupWorkspaceTab }
  | { kind: 'contact-notice'; notice: 'friend' | 'group' }
  | { kind: 'assistant' }
  | { kind: 'qzone'; target: QzoneCardTarget }
  | { kind: 'group-resource'; request: Omit<GroupResourceRequest, 'onJumpToMessage'> }
  | { kind: 'local'; open: () => unknown };

export interface NotificationSource {
  label: string;
  target: NotificationTarget;
  binding: ReturnType<typeof accountBinding>;
}

const NAVIGATE = 'weq:notification-navigate';
export const NotificationSourceContext = createContext<NotificationSource | null>(null);

export function notificationSource(
  target: NotificationTarget,
  label = '定位通知来源',
  binding = accountBinding(),
): NotificationSource {
  return { target, label, binding: binding ? { ...binding } : null };
}

export function NotificationSourceProvider({
  source,
  children,
}: {
  source: NotificationSource | null;
  children?: ReactNode;
}) {
  return (
    <NotificationSourceContext.Provider value={source}>
      {children}
    </NotificationSourceContext.Provider>
  );
}

export function notificationContent(source: NotificationSource | null, children: ReactNode) {
  return <NotificationSourceProvider source={source}>{children}</NotificationSourceProvider>;
}

export function SettingsNotificationSource({
  section,
  children,
}: {
  section: Extract<AppSearchTarget, { kind: 'setting' }>['section'];
  children?: ReactNode;
}) {
  const inherited = useContext(NotificationSourceContext);
  const binding = [
    'account',
    'credentials',
    'diagnostics',
    'database-management',
    'qq-storage',
  ].includes(section)
    ? (inherited?.binding ?? undefined)
    : null;
  const source = useMemo(
    () =>
      notificationSource(
        { kind: 'app', target: { kind: 'setting', section } },
        '返回对应设置',
        binding,
      ),
    [section, binding],
  );
  return <NotificationSourceProvider source={source}>{children}</NotificationSourceProvider>;
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
  message: Pick<Message, 'id' | 'msgId' | 'msgSeq' | 'sourceFormat' | 'ntSeqVerified'>,
  binding = accountBinding(),
) {
  return notificationSource(
    {
      kind: 'conversation',
      conversationKind: conversation.type === 'group' ? 'group' : 'c2c',
      conv: conversation.id,
      msgId: message.msgId ?? message.id,
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
