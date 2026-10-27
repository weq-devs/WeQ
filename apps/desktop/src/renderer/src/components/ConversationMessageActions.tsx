import {
  BarChart3,
  CirclePlus,
  CloudDownload,
  Download,
  ListRestart,
  ListX,
  Loader2,
  MessageSquareText,
  Pause,
  Users,
} from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import type { Conversation } from '../im-template/template/types';
import {
  conversationAnalysisTarget,
  conversationExportSelection,
  conversationRoamingTarget,
} from '../lib/conversationActions';
import { ConversationDirectoryContext } from '../lib/conversationDirectory';
import { useRequestContentExport } from '../state/contentSelection';
import { useTabActive } from './RetainedTabs';
import { trpc } from '../trpc/client';
import { ConversationActionsMenu } from './ConversationActionsMenu';
import '../styles/conversation-actions.css';

export function ConversationMessageActions({
  conversation,
  onRoaming,
  onDeleted,
  onRecalled,
  onAdd,
}: {
  conversation: Conversation;
  onRoaming?: (conversation: Conversation) => void;
  onDeleted?: (conversation: Conversation) => void;
  onRecalled?: (conversation: Conversation) => void;
  onAdd?: (conversation: Conversation) => void;
}) {
  const directory = useContext(ConversationDirectoryContext);
  const requestExport = useRequestContentExport();
  const generated = Boolean(conversation.generated);
  const unsupported = generated ? '克隆会话暂不支持此功能' : undefined;
  const exportSelection = conversationExportSelection(conversation);
  const target = conversationRoamingTarget(conversation);
  const active = useTabActive();
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => setMenu(null), [conversation.id, active]);
  const state = trpc.account.roamingBackfill.list.useQuery(undefined, {
    enabled: active && Boolean(target && onRoaming),
    refetchInterval: active && target && onRoaming ? 1000 : false,
    refetchOnWindowFocus: false,
  });
  const job =
    target && onRoaming
      ? state.data?.jobs
          .filter((item) =>
            item.targets.some((value) => value.kind === target.kind && value.conv === target.conv),
          )
          .sort((a, b) => b.createdAt - a.createdAt)[0]
      : undefined;
  const running = job?.status === 'running' || job?.status === 'pausing';
  const percent =
    job && job.plannedSeqs > 0
      ? Math.min(
          100,
          Math.max(0, Math.floor(((job.plannedSeqs - job.remainingSeqs) / job.plannedSeqs) * 100)),
        )
      : 0;
  const status =
    job?.status === 'pausing'
      ? '暂停收尾中'
      : running
        ? `${percent}%`
        : job?.status === 'paused'
          ? '已暂停'
          : undefined;
  const actions = [
    ...((directory?.onAnalyze && conversationAnalysisTarget(conversation)) || generated
      ? [
          {
            label: '分析',
            icon: <BarChart3 size={16} />,
            action: () => directory?.onAnalyze?.(conversation),
            disabled: generated,
            reason: unsupported,
          },
        ]
      : []),
    ...((requestExport || generated) && exportSelection
      ? [
          {
            label: '导出',
            icon: <Download size={16} />,
            action: () => requestExport?.(exportSelection),
            disabled: !requestExport,
          },
        ]
      : []),
    ...((requestExport && conversation.type === 'group' && target) ||
    (generated && conversation.type === 'group')
      ? [
          {
            label: '导出名单',
            icon: <Users size={16} />,
            action: () =>
              requestExport?.({
                owner: { kind: 'contacts', container: `group:${conversation.group.id}` },
                scope: { type: 'all' },
              }),
            disabled: generated,
            reason: unsupported,
          },
        ]
      : []),
    ...((target && onRoaming) || generated
      ? [
          {
            label: '拉取漫游消息',
            icon: <CloudDownload size={16} />,
            action: () => onRoaming?.(conversation),
            disabled: generated,
            reason: unsupported,
          },
        ]
      : []),
    ...(onRecalled || generated
      ? [
          {
            label: '撤回列表',
            icon: <ListRestart size={16} />,
            action: () => onRecalled?.(conversation),
            disabled: generated,
            reason: unsupported,
          },
        ]
      : []),
    ...(onDeleted || generated
      ? [
          {
            label: '删除列表',
            icon: <ListX size={16} />,
            action: () => onDeleted?.(conversation),
            disabled: generated,
            reason: unsupported,
          },
        ]
      : []),
    ...(onAdd || generated
      ? [
          {
            label: '添加本地消息',
            icon: <CirclePlus size={16} />,
            separatorBefore: Boolean(onRecalled || onDeleted || (target && onRoaming)),
            reason: '仅插入本地记录，不会发送给对方',
            action: () => onAdd?.(conversation),
            disabled: generated,
          },
        ]
      : []),
  ];
  if (!actions.length) return null;
  const open = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button group-header-info-action weq-conversation-message-actions"
        title={status ? `消息管理 · 漫游拉取任务 ${status}` : '消息管理'}
        aria-label="消息管理"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={() => (menu ? setMenu(null) : open())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            open();
          }
        }}
      >
        {running ? <Loader2 size={18} /> : <MessageSquareText size={18} />}
        {job?.status === 'paused' || job?.status === 'pausing' ? (
          <span className="weq-roaming-paused-indicator" aria-hidden="true">
            <Pause size={9} strokeWidth={3} />
          </span>
        ) : running ? (
          <small>{status}</small>
        ) : null}
      </button>
      {menu ? (
        <ConversationActionsMenu
          label="消息管理"
          x={menu.x}
          y={menu.y}
          actions={actions}
          onClose={() => {
            setMenu(null);
            trigger.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </>
  );
}
