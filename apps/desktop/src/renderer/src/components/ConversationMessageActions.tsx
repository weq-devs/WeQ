import {
  BarChart3,
  Bug,
  CirclePlus,
  Ellipsis,
  ListFilter,
  ListRestart,
  ListX,
  MessageSquareText,
  MoreHorizontal,
  Search,
  Settings2,
  Sparkles,
  Users,
  UsersRound,
  Wrench,
  X,
} from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import type { Conversation } from '../im-template/template/types';
import {
  conversationAnalysisTarget,
  conversationExportSelection,
  conversationRoamingTarget,
  conversationSourceLabel,
} from '../lib/conversationActions';
import { ConversationDirectoryContext } from '../lib/conversationDirectory';
import { ContactWorkspaceNavigationContext, contactPortraitTarget } from '../lib/profileNavigation';
import { displayUserName } from '../im-template/template/user';
import { useRequestContentExport } from '../state/contentSelection.shared';
import { useTabActive } from './RetainedTabs.shared';
import { ConversationActionsMenu, type ConversationMenuAction } from './ConversationActionsMenu';
import { useRemoteShellAvailable } from './RemoteShellMenus.shared';
import '../styles/conversation-actions.css';
import { FEATURE_ICONS } from '../lib/featureIcons.shared';

const ExportIcon = FEATURE_ICONS.export;
const BackfillIcon = FEATURE_ICONS.backfill;

export function ConversationMessageActions({
  conversation,
  onRoaming,
  onDeleted,
  onRecalled,
  onAdd,
  compact = false,
  showPortrait = false,
  onSearch,
  onImportant,
  dismissJumpActions,
  onGroupInfo,
  onSettings,
  settingsLabel = '会话设置',
  onBug,
  bugOnline = false,
}: {
  conversation: Conversation;
  onRoaming?: (conversation: Conversation) => void;
  onDeleted?: (conversation: Conversation) => void;
  onRecalled?: (conversation: Conversation) => void;
  onAdd?: (conversation: Conversation) => void;
  compact?: boolean;
  showPortrait?: boolean;
  onSearch?: () => void;
  onImportant?: () => void;
  dismissJumpActions?: { label: string; action: () => void }[];
  onGroupInfo?: (anchor: HTMLButtonElement) => void;
  onSettings?: (anchor: HTMLButtonElement) => void;
  settingsLabel?: string;
  onBug?: () => void;
  bugOnline?: boolean;
}) {
  const directory = useContext(ConversationDirectoryContext);
  const openWorkspace = useContext(ContactWorkspaceNavigationContext);
  const requestExport = useRequestContentExport();
  const sourceLabel = conversationSourceLabel(conversation);
  const generated = Boolean(sourceLabel);
  const exportSelection = conversationExportSelection(conversation);
  const target = conversationRoamingTarget(conversation);
  const portraitPeer =
    compact && showPortrait && conversation.type === 'direct' ? conversation.otherUser : null;
  const active = useTabActive();
  const remoteShell = useRemoteShellAvailable();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    label: string;
  } | null>(null);
  useEffect(() => setMenu(null), [conversation.id, active, compact]);
  const messages: ConversationMenuAction[] = [
    ...(onImportant
      ? [{ label: '重要消息', icon: <ListFilter size={16} />, action: onImportant }]
      : []),
    ...(onRecalled && !generated
      ? [
          {
            label: '已撤回消息',
            icon: <ListRestart size={16} />,
            action: () => onRecalled(conversation),
          },
        ]
      : []),
    ...(onDeleted && !generated
      ? [{ label: '已删除消息', icon: <ListX size={16} />, action: () => onDeleted(conversation) }]
      : []),
    ...(dismissJumpActions?.map(({ label, action }) => ({
      label,
      icon: <X size={16} />,
      action,
    })) ?? []),
    ...(onAdd && !generated
      ? [
          {
            label: '添加本地消息',
            icon: <CirclePlus size={16} />,
            separatorBefore: Boolean(
              onImportant || onRecalled || onDeleted || dismissJumpActions?.length,
            ),
            reason: '仅插入本地记录，不会发送给对方',
            action: () => onAdd(conversation),
          },
        ]
      : []),
  ];
  const tools: ConversationMenuAction[] = [
    ...(target && onRoaming && !generated
      ? [
          {
            label: '拉取漫游消息',
            icon: <BackfillIcon size={16} />,
            action: () => onRoaming(conversation),
          },
        ]
      : []),
    ...(!generated && directory?.onAnalyze && conversationAnalysisTarget(conversation)
      ? [
          {
            label: '会话分析',
            icon: <BarChart3 size={16} />,
            action: () => directory?.onAnalyze?.(conversation),
          },
        ]
      : []),
    ...(requestExport && exportSelection
      ? [
          {
            label: '导出聊天记录',
            icon: <ExportIcon size={16} />,
            action: () => requestExport?.(exportSelection),
            disabled: !requestExport,
          },
        ]
      : []),
    ...(requestExport && conversation.type === 'group' && target && !generated
      ? [
          {
            label: '导出群成员名单',
            icon: <Users size={16} />,
            action: () =>
              requestExport?.({
                owner: { kind: 'contacts', container: `group:${conversation.group.id}` },
                scope: { type: 'all' },
              }),
          },
        ]
      : []),
    ...(onGroupInfo
      ? [
          {
            label: '群聊侧栏',
            icon: <UsersRound size={16} />,
            action: () => {
              if (trigger.current) onGroupInfo(trigger.current);
            },
            separatorBefore: true,
          },
        ]
      : []),
    ...(remoteShell
      ? [
          {
            label: '连接菜单',
            icon: <Ellipsis size={16} />,
            action: () => window.weqRemoteShell?.openMenu(),
            separatorBefore: true,
          },
        ]
      : []),
  ];
  if (tools[0]) tools[0].separatorBefore = false;
  const actions: ConversationMenuAction[] = [
    ...(onBug
      ? [
          {
            label: '反馈 Bug',
            icon: <Bug size={18} />,
            action: onBug,
            disabled: !bugOnline,
            reason: bugOnline ? undefined : '在线能力受限，无法反馈 Bug',
          },
        ]
      : []),
    ...(onSearch ? [{ label: '搜索', icon: <Search size={18} />, action: onSearch }] : []),
    ...(portraitPeer
      ? [
          {
            label: '互动画像',
            icon: <Sparkles size={18} />,
            disabled: !openWorkspace,
            action: () =>
              openWorkspace?.(
                contactPortraitTarget(portraitPeer.id, displayUserName(portraitPeer)),
              ),
          },
        ]
      : []),
    ...(messages.length
      ? [{ label: '消息', icon: <MessageSquareText size={18} />, children: messages }]
      : []),
    { label: '工具', icon: <Wrench size={18} />, children: tools, disabled: !tools.length },
    ...(onSettings
      ? [{ label: settingsLabel, icon: <Settings2 size={18} />, action: onSettings }]
      : []),
  ];
  // 没有宿主能力的虚拟对象不单独显示空工具栏。
  if (actions.length === 1 && !tools.length) return null;
  const menuActions =
    menu && (compact ? actions : actions.find((item) => item.label === menu.label)?.children);
  const open = (button: HTMLButtonElement, label: string) => {
    const rect = button.getBoundingClientRect();
    const header = compact ? button.closest('.chat-header')?.getBoundingClientRect() : null;
    trigger.current = button;
    setMenu((old) =>
      old?.label === label
        ? null
        : {
            x: rect.right,
            y: (header?.bottom ?? rect.bottom) + 4,
            label,
          },
    );
  };
  const close = () => {
    setMenu(null);
    trigger.current?.focus({ preventScroll: true });
  };
  return (
    <>
      {compact ? (
        <button
          type="button"
          className="icon-button group-header-info-action weq-conversation-message-actions"
          title="更多"
          aria-label="更多会话操作"
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          onClick={(event) => open(event.currentTarget, '会话操作')}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (!menu) open(event.currentTarget, '会话操作');
            }
          }}
        >
          <MoreHorizontal size={18} />
        </button>
      ) : (
        actions.map((item) => (
          <button
            key={item.label}
            type="button"
            className="icon-button group-header-info-action weq-conversation-message-actions"
            title={item.reason ?? item.label}
            aria-label={item.label}
            disabled={item.disabled}
            aria-haspopup={item.children ? 'menu' : undefined}
            aria-expanded={item.children ? menu?.label === item.label : undefined}
            onClick={(event) => {
              if (item.children) open(event.currentTarget, item.label);
              else {
                setMenu(null);
                item.action?.(event.currentTarget);
              }
            }}
            onKeyDown={(event) => {
              if (item.children && event.key === 'ArrowDown') {
                event.preventDefault();
                if (menu?.label !== item.label) open(event.currentTarget, item.label);
              }
            }}
          >
            {item.icon}
          </button>
        ))
      )}
      {menu && menuActions ? (
        <ConversationActionsMenu
          key={menu.label}
          label={menu.label}
          dropdown
          x={menu.x}
          y={menu.y}
          actions={menuActions}
          onClose={close}
        />
      ) : null}
    </>
  );
}
