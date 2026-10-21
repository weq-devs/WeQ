import { formatConversationTimestamp } from '../../lib/conversationTime';
import { conversationActivityTime } from '@weq/service/conversation-order';
import {
  X,
  EyeOff,
  Trash2,
  Pin,
  PinOff,
  ListChecks,
  Download,
  CloudDownload,
  BarChart3,
  MailOpen,
} from 'lucide-react';
import { useMemo, useEffect, useRef, useState, useContext } from 'react';
import { classifyChatType } from '@weq/codec';
import { Avatar } from '../../im-template/template/primitives';
import type { Conversation, MergedKind } from '../../im-template/template/types';
import { trpc } from '../../trpc/client';
import { resolveAvatar, avatarFromGroupCode } from '../../lib/avatarResolver';
import { isAssistantPinned, type GroupAssistantPins } from '../../lib/groupAssistant';
import { ConversationDirectoryContext } from '../../lib/conversationDirectory';
import { conversationAnalysisTarget } from '../../lib/conversationActions';
import { previewNodes, previewNodesToText } from '../../lib/conversationPreview';
import { useContentMultiSelect } from '../../state/contentSelection';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { allSelectionIdsSelected, toggleAllSelectionIds } from '../../lib/multiSelection';
import { ConversationActionsMenu } from '../ConversationActionsMenu';
import { ConversationSelectionToolbar } from '../ConversationSelectionToolbar';
import { useConversationBatchActions } from '../useConversationBatchActions';
import '../../styles/group-assistant.css';

const emptyPins: GroupAssistantPins = {};

/** Wire types from tRPC (bigint → string serialization) */
interface DeletedSessionWire {
  sessionKey: string;
  chatType: number;
  targetUid: string;
  resolvable: boolean;
  sendTime: string;
  senderUid: string;
  preview: unknown;
  deleteTime: string;
}

/** 频道私聊会话（serde.guildDirectSessionToWire）。 */
interface GuildDirectSessionWire {
  nodeId: string;
  lastTime: string;
  lastSeq: string;
  peerTinyId: string;
  peerNick: string;
  peerAvatarUrl: string | null;
  preview: unknown | null;
}

interface HiddenSessionWire {
  storageKey: string;
  chatType: string | number;
  targetUid: string;
  targetUin: string;
  resolvable: boolean;
  sendTime: string;
  senderUid: string;
  preview: unknown;
}

interface OfficialAccountSummaryWire {
  peerUid: string;
  displayName: string;
  avatarUrl: string | null;
  targetUin: string;
  sendTime: string;
  prompt: string | null;
}

interface ServiceAccountSummaryWire {
  appId: string;
  displayName: string;
  avatarUrl: string | null;
  sendTime: string;
  prompt: string | null;
}

/** 隐藏会话昵称/头像解析用的最小 profile 形状（与 MainView 的 UserProfileWire 对齐）。 */
interface HiddenProfileLike {
  nick?: string;
  remark?: string;
  qid?: string;
  uin?: string;
  avatarUrl?: string;
}

interface MergedSessionPanelProps {
  kind: MergedKind;
  conversations: Conversation[];
  /** Membership comes only from official recent-contact notifyLevel 2 rows. */
  groupAssistantIds?: ReadonlySet<string>;
  groupAssistantPins?: GroupAssistantPins;
  onGroupAssistantPin?: (id: string, pinned: boolean) => void;
  groupAssistantLoading?: boolean;
  groupAssistantError?: string;
  groupAssistantHasMore?: boolean;
  onLoadMoreGroupAssistant?: () => void;
  anchorX: number;
  anchorY: number;
  onBack: () => void;
  onSelectConversation: (conv: Conversation) => void;
  /** uid → profile，用于隐藏单聊会话解析昵称/头像（该表不带 QQ 预置的显示名列）。 */
  profileByUid?: Map<string, HiddenProfileLike>;
  /** 群号 → 群名，用于隐藏群聊会话解析名称。 */
  groupNameByCode?: Map<string, string>;
}

function toIsoTime(seconds: string | undefined): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return new Date(0).toISOString();
  return new Date(value * 1000).toISOString();
}

export function MergedSessionPanel({
  kind,
  conversations: _conversations,
  groupAssistantIds,
  groupAssistantPins = emptyPins,
  onGroupAssistantPin,
  groupAssistantLoading = false,
  groupAssistantError,
  groupAssistantHasMore = false,
  onLoadMoreGroupAssistant,
  anchorX,
  anchorY,
  onBack,
  onSelectConversation,
  profileByUid,
  groupNameByCode,
}: MergedSessionPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: anchorX, y: anchorY });
  const [groupSearch, setGroupSearch] = useState('');
  const [selectingAll, setSelectingAll] = useState(false);
  const directory = useContext(ConversationDirectoryContext);
  const batch = useConversationBatchActions(_conversations);
  const { selectionMode, selectedIds, setSelectedIds, setSelectionMode, anchorRef } =
    useContentMultiSelect({
      kind: 'conversations',
      container: 'main-list',
    });
  const [actionMenu, setActionMenu] = useState<{
    conversation: Conversation;
    ids: string[];
    x: number;
    y: number;
  } | null>(null);

  // 获取公众号/服务号原始数据
  const officialAccounts = trpc.account.listOfficialAccounts.useQuery(undefined, {
    enabled: kind === 'official',
  });
  const serviceAccounts = trpc.account.listServiceAccounts.useQuery(undefined, {
    enabled: kind === 'service',
  });

  // 计算面板位置，确保不超出视口
  useEffect(() => {
    if (!panelRef.current) return;

    const panel = panelRef.current;
    const rect = panel.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = anchorX;
    let y = anchorY;

    // 默认显示在右侧
    const showOnRight = x + 340 < viewportWidth;
    if (showOnRight) {
      x = Math.min(x, viewportWidth - 340 - 12);
    } else {
      // 放不下就显示在左侧
      x = Math.max(12, x - 340);
    }

    // 垂直方向：尽量对齐点击位置，但不超出视口
    y = Math.max(12, Math.min(y, viewportHeight - rect.height - 12));

    setPosition({ x, y });
  }, [
    anchorX,
    anchorY,
    kind,
    _conversations.length,
    groupAssistantIds?.size,
    groupAssistantLoading,
    groupSearch,
  ]);

  // 点击面板外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (actionMenu || batch.confirming) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onBack();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onBack, actionMenu, batch.confirming]);

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (actionMenu || batch.confirming || selectionMode) return;
        onBack();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onBack, actionMenu, batch.confirming, selectionMode]);

  // 获取隐藏会话原始数据
  const hiddenSessions = trpc.account.listHiddenSessions.useQuery(undefined, {
    enabled: kind === 'hidden',
  });

  // 获取删除会话原始数据
  const deletedSessions = trpc.account.listDeletedSessions.useQuery(undefined, {
    enabled: kind === 'deleted',
  });
  // 频道私聊：与「公众号」同一种聚合入口，点开展开各私聊会话。
  const guildSessions = trpc.account.guildDirectListSessions.useQuery(undefined, {
    enabled: kind === 'guildDirect',
  });

  const filtered = useMemo<Conversation[]>(() => {
    if (kind === 'guildDirect') {
      return ((guildSessions.data ?? []) as GuildDirectSessionWire[]).map((session) => ({
        id: `guild:${session.nodeId}`,
        type: 'direct',
        otherUser: {
          id: `guild:${session.nodeId}`,
          identityLabel: '频道',
          identityValue: session.peerTinyId,
          username: session.peerNick || session.peerTinyId,
          displayName: session.peerNick || session.peerTinyId,
          avatarUrl: session.peerAvatarUrl,
        },
        group: null,
        members: [],
        updatedAt: new Date(Number(session.lastTime) * 1000).toISOString(),
        preference: { pinned: false, muted: false, blocked: false },
        unreadCount: 0,
        lastMessage: {
          id: `guild:${session.nodeId}:${session.lastSeq}`,
          senderId: null,
          body: previewNodesToText(previewNodes(session.preview ?? null)),
          createdAt: new Date(Number(session.lastTime) * 1000).toISOString(),
        },
      }));
    }
    if (kind === 'groupAssistant')
      return _conversations.filter(
        (conversation) => conversation.type === 'group' && groupAssistantIds?.has(conversation.id),
      );
    if (kind === 'deleted') {
      // 从 deletedSessions 数据构建会话列表
      if (!deletedSessions.data) return [];
      return deletedSessions.data
        .filter((deleted: DeletedSessionWire) => deleted.resolvable && deleted.targetUid)
        .map<Conversation>((deleted: DeletedSessionWire) => {
          const isGroup = deleted.chatType === 2;

          if (isGroup) {
            const groupName = groupNameByCode?.get(deleted.targetUid) || deleted.targetUid;
            return {
              id: deleted.targetUid,
              type: 'group' as const,
              chatType: 2,
              updatedAt: toIsoTime(deleted.sendTime),
              otherUser: null,
              group: {
                id: deleted.targetUid,
                name: groupName,
                identityLabel: 'Group' as const,
                identityValue: deleted.targetUid,
                avatarUrl: avatarFromGroupCode(deleted.targetUid),
                announcement: null,
                memberCount: 1,
                role: 'member' as const,
              },
              members: [],
              preference: { pinned: false, muted: false, blocked: false },
              unreadCount: 0,
              lastMessage: {
                id: `deleted:${deleted.targetUid}:${deleted.sendTime}`,
                senderId: deleted.senderUid,
                body: '',
                createdAt: toIsoTime(deleted.sendTime),
              },
            };
          }

          const profile = profileByUid?.get(deleted.targetUid);
          const displayName = profile?.remark || profile?.nick || profile?.qid || deleted.targetUid;
          const avatarUrl = resolveAvatar({
            uin: profile?.uin,
            profileAvatarUrl: profile?.avatarUrl,
          });

          return {
            id: deleted.targetUid,
            type: 'direct' as const,
            chatType: 1,
            updatedAt: toIsoTime(deleted.sendTime),
            otherUser: {
              id: deleted.targetUid,
              identityLabel: 'UID' as 'UID',
              identityValue: deleted.targetUid,
              username: deleted.targetUid,
              displayName,
              kind: 'human' as const,
              avatarUrl,
            },
            group: null,
            members: [],
            preference: { pinned: false, muted: false, blocked: false },
            unreadCount: 0,
            lastMessage: {
              id: `deleted:${deleted.targetUid}:${deleted.sendTime}`,
              senderId: deleted.senderUid,
              body: '',
              createdAt: toIsoTime(deleted.sendTime),
            },
          };
        });
    }
    if (kind === 'hidden') {
      // 直接从 hiddenSessions 数据构建会话列表。「两表都有才算隐藏会话」的判断
      // 已经在后端 HiddenSessionService 里用不受分页限制的精确查询做过了 ——
      // resolvable=true 就已经蕴含「hidden_session_storage_table_v1 和
      // recent_contact_v3_table 两表都有这条记录」，这里不用再判一次。
      if (!hiddenSessions.data) return [];
      return hiddenSessions.data
        .filter((hidden: HiddenSessionWire) => hidden.resolvable && hidden.targetUid)
        .map<Conversation>((hidden: HiddenSessionWire) => {
          // chatType 是枚举名字符串（如 "KCHATTYPEGROUP"），不是数字 —— 必须走
          // classifyChatType 判定，不能拿 typeof === 'number' 硬判，否则群聊永远
          // 落进单聊分支，头像/身份全部判错。
          const isGroup = classifyChatType(hidden.chatType) === 'group';

          if (isGroup) {
            const groupName = groupNameByCode?.get(hidden.targetUid) || hidden.targetUid;
            return {
              id: hidden.targetUid,
              type: 'group' as const,
              chatType: 2,
              updatedAt: toIsoTime(hidden.sendTime),
              otherUser: null,
              group: {
                id: hidden.targetUid,
                name: groupName,
                identityLabel: 'Group' as const,
                identityValue: hidden.targetUid,
                avatarUrl: avatarFromGroupCode(hidden.targetUid),
                announcement: null,
                memberCount: 1,
                role: 'member' as const,
              },
              members: [],
              preference: { pinned: false, muted: false, blocked: false },
              unreadCount: 0,
              lastMessage: {
                id: `hidden:${hidden.targetUid}:${hidden.sendTime}`,
                senderId: hidden.senderUid,
                body: '', // 后端已解析 preview，但这里暂时留空
                createdAt: toIsoTime(hidden.sendTime),
              },
            };
          }

          const profile = profileByUid?.get(hidden.targetUid);
          const displayName =
            profile?.remark ||
            profile?.nick ||
            profile?.qid ||
            (hidden.targetUin && hidden.targetUin !== '0' ? hidden.targetUin : hidden.targetUid);
          const avatarUrl = resolveAvatar({
            uin: hidden.targetUin && hidden.targetUin !== '0' ? hidden.targetUin : profile?.uin,
            profileAvatarUrl: profile?.avatarUrl,
          });

          return {
            id: hidden.targetUid,
            type: 'direct' as const,
            chatType: 1,
            updatedAt: toIsoTime(hidden.sendTime),
            otherUser: {
              id: hidden.targetUid,
              identityLabel: (hidden.targetUin && hidden.targetUin !== '0' ? 'QQ' : 'UID') as
                | 'QQ'
                | 'UID',
              identityValue:
                hidden.targetUin && hidden.targetUin !== '0' ? hidden.targetUin : hidden.targetUid,
              username: hidden.targetUid,
              displayName,
              kind: 'human' as const,
              avatarUrl,
            },
            group: null,
            members: [],
            preference: { pinned: false, muted: false, blocked: false },
            unreadCount: 0,
            lastMessage: {
              id: `hidden:${hidden.targetUid}:${hidden.sendTime}`,
              senderId: hidden.senderUid,
              body: '', // 后端已解析 preview，但这里暂时留空
              createdAt: toIsoTime(hidden.sendTime),
            },
          };
        });
    }
    if (kind === 'official') {
      // 从 officialAccounts 数据构建会话列表
      if (!officialAccounts.data) return [];
      return officialAccounts.data.map<Conversation>((official: OfficialAccountSummaryWire) => {
        const avatarUrl = resolveAvatar({
          uin: official.targetUin && official.targetUin !== '0' ? official.targetUin : undefined,
        });
        return {
          id: official.peerUid,
          type: 'direct' as const,
          chatType: 103,
          updatedAt: toIsoTime(official.sendTime),
          otherUser: {
            id: official.peerUid,
            identityLabel: 'UID' as const,
            identityValue: official.peerUid,
            username: official.peerUid,
            displayName: official.displayName || official.peerUid,
            kind: 'human' as const,
            avatarUrl,
          },
          group: null,
          members: [],
          preference: { pinned: false, muted: false, blocked: false },
          unreadCount: 0,
          lastMessage: {
            id: `official:${official.peerUid}:${official.sendTime}`,
            senderId: official.peerUid,
            body: official.prompt,
            createdAt: toIsoTime(official.sendTime),
          },
        };
      });
    }
    if (kind === 'service') {
      // 从 serviceAccounts 数据构建会话列表
      if (!serviceAccounts.data) return [];
      return serviceAccounts.data.map<Conversation>((service: ServiceAccountSummaryWire) => {
        const avatarUrl = resolveAvatar({
          uin: undefined,
          profileAvatarUrl: service.avatarUrl,
        });
        return {
          id: `service:${service.appId}`,
          type: 'direct' as const,
          chatType: 118,
          updatedAt: toIsoTime(service.sendTime),
          otherUser: {
            id: service.appId,
            identityLabel: 'AppID' as const,
            identityValue: service.appId,
            username: service.appId,
            displayName: service.displayName || service.appId,
            kind: 'human' as const,
            avatarUrl,
          },
          group: null,
          members: [],
          preference: { pinned: false, muted: false, blocked: false },
          unreadCount: 0,
          lastMessage: {
            id: `service:${service.appId}:${service.sendTime}`,
            senderId: service.appId,
            body: service.prompt,
            createdAt: toIsoTime(service.sendTime),
          },
        };
      });
    }
    return [];
  }, [
    kind,
    _conversations,
    groupAssistantIds,
    deletedSessions.data,
    hiddenSessions.data,
    guildSessions.data,
    officialAccounts.data,
    serviceAccounts.data,
    profileByUid,
    groupNameByCode,
  ]);

  const sortedThreads = useMemo(
    () =>
      filtered
        .filter((conversation) => {
          if (kind !== 'groupAssistant' || !groupSearch.trim()) return true;
          const term = groupSearch.trim().toLocaleLowerCase();
          return (
            conversation.id.includes(term) ||
            (conversation.type === 'group' &&
              conversation.group.name.toLocaleLowerCase().includes(term))
          );
        })
        .sort((a, b) => {
          if (kind === 'groupAssistant') {
            const pinOrder =
              Number(isAssistantPinned(b, groupAssistantPins)) -
              Number(isAssistantPinned(a, groupAssistantPins));
            if (pinOrder) return pinOrder;
          }
          return (
            conversationActivityTime(b) - conversationActivityTime(a) || a.id.localeCompare(b.id)
          );
        }),
    [filtered, groupSearch, kind, groupAssistantPins],
  );

  const title =
    kind === 'guildDirect'
      ? '频道私聊'
      : kind === 'groupAssistant'
        ? '群助手'
        : kind === 'hidden'
          ? '隐藏的会话'
          : kind === 'deleted'
            ? '最近删除'
            : kind === 'service'
              ? 'QQ服务号'
              : 'QQ官方账号';
  const ids = sortedThreads.map((row) => row.id);
  const allSelected = allSelectionIdsSelected(ids, selectedIds);
  const toggleAll = () => {
    if (selectingAll) {
      setSelectingAll(false);
      return;
    }
    if (groupAssistantHasMore || groupAssistantLoading) {
      setSelectingAll(true);
      onLoadMoreGroupAssistant?.();
      return;
    }
    setSelectedIds(toggleAllSelectionIds(ids, selectedIds));
  };
  useEffect(() => {
    if (!selectingAll) return;
    if (!selectionMode || groupAssistantError) {
      setSelectingAll(false);
      return;
    }
    if (!groupAssistantHasMore && !groupAssistantLoading) {
      setSelectedIds((current) => new Set([...current, ...ids]));
      setSelectingAll(false);
    } else if (groupAssistantHasMore && !groupAssistantLoading) onLoadMoreGroupAssistant?.();
  }, [
    selectingAll,
    selectionMode,
    groupAssistantError,
    groupAssistantHasMore,
    groupAssistantLoading,
    ids,
    onLoadMoreGroupAssistant,
    setSelectedIds,
  ]);
  const multi = useMultiSelection({
    anchorRef,
    ids,
    selected: selectedIds,
    onChange: (next) => {
      if ((groupAssistantHasMore || groupAssistantLoading) && ids.every((id) => next.has(id))) {
        setSelectingAll(true);
        onLoadMoreGroupAssistant?.();
        return;
      }
      setSelectingAll(false);
      setSelectedIds(next);
    },
    enabled: kind === 'groupAssistant' && selectionMode,
    disabled: kind !== 'groupAssistant',
    onStart: () => setSelectionMode(true),
    onExit: () => setSelectionMode(false),
  });

  return (
    <div className="weq-merged-overlay">
      <div
        {...multi.rootProps}
        ref={(element) => {
          panelRef.current = element;
          multi.rootProps.ref(element);
        }}
        className="weq-merged-popover"
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
        }}
      >
        <div className="weq-merged-popover-header">
          <div className="weq-merged-popover-title">
            {title}
            {kind === 'groupAssistant' ? (
              <span className="weq-group-helper-count"> · {filtered.length} 个群</span>
            ) : null}
          </div>
          <button type="button" className="weq-merged-popover-close" onClick={onBack}>
            <X size={16} />
          </button>
        </div>
        {kind === 'groupAssistant' ? (
          <div className="weq-group-helper-search">
            <input
              aria-label="搜索群助手"
              placeholder="搜索群名或群号"
              value={groupSearch}
              onChange={(event) => setGroupSearch(event.target.value)}
            />
          </div>
        ) : null}
        <div className="weq-merged-popover-body">
          {kind === 'groupAssistant' && groupAssistantError ? (
            <div className="weq-merged-popover-empty" role="status">
              群助手读取失败：{groupAssistantError}
            </div>
          ) : null}
          {sortedThreads.map((conv) => {
            const preview = conv.lastMessage?.body ?? '';
            const unreadCount = conv.unreadCount ?? 0;
            const time = formatConversationTimestamp(conv.updatedAt);
            const name = conv.type === 'group' ? conv.group?.name : conv.otherUser?.displayName;
            const avatarUrl =
              conv.type === 'group' ? conv.group?.avatarUrl : conv.otherUser?.avatarUrl;
            const seed = conv.type === 'direct' ? conv.otherUser?.identityValue : conv.id;
            const pinned = kind === 'groupAssistant' && isAssistantPinned(conv, groupAssistantPins);

            return (
              <div
                key={conv.id}
                className={`weq-merged-popover-row${pinned ? ' is-pinned' : ''}${kind === 'groupAssistant' && selectedIds.has(conv.id) ? ' is-multiselected' : ''}`}
              >
                <button
                  type="button"
                  className="weq-merged-popover-item"
                  {...(kind === 'groupAssistant' ? multi.itemProps(conv.id) : {})}
                  aria-pressed={
                    kind === 'groupAssistant' && selectionMode
                      ? selectedIds.has(conv.id)
                      : undefined
                  }
                  onContextMenu={(event) => {
                    if (kind !== 'groupAssistant') return;
                    event.preventDefault();
                    setActionMenu({
                      conversation: conv,
                      ids: selectionMode && selectedIds.has(conv.id) ? [...selectedIds] : [conv.id],
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                  onKeyDown={(event) => {
                    if (
                      kind !== 'groupAssistant' ||
                      (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                    )
                      return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setActionMenu({
                      conversation: conv,
                      ids: selectionMode && selectedIds.has(conv.id) ? [...selectedIds] : [conv.id],
                      x: rect.left + 20,
                      y: rect.top + 20,
                    });
                  }}
                  onClick={() => {
                    onSelectConversation(conv as Conversation);
                    onBack();
                  }}
                >
                  <Avatar name={name ?? ''} avatarUrl={avatarUrl} seed={seed ?? conv.id} />
                  <div className="weq-merged-popover-item-main">
                    <div className="weq-merged-popover-item-top">
                      <div className="weq-merged-popover-item-name">{name}</div>
                      {pinned ? (
                        <Pin size={12} aria-label="置顶" className="weq-group-helper-pin-mark" />
                      ) : null}
                      {time && <div className="weq-merged-popover-item-time">{time}</div>}
                    </div>
                    {preview && <div className="weq-merged-popover-item-preview">{preview}</div>}
                  </div>
                  {kind === 'groupAssistant' && unreadCount > 0 ? (
                    <span
                      className="weq-group-helper-unread"
                      aria-label={`${unreadCount} 条未读消息`}
                    >
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  ) : null}
                  {kind === 'hidden' && (
                    <EyeOff size={14} className="weq-merged-popover-item-badge" />
                  )}
                  {kind === 'deleted' && (
                    <Trash2 size={14} className="weq-merged-popover-item-badge" />
                  )}
                </button>
              </div>
            );
          })}
          {sortedThreads.length === 0 &&
            !(kind === 'groupAssistant' && (groupAssistantLoading || groupAssistantError)) && (
              <div className="weq-merged-popover-empty">
                {kind === 'groupAssistant' && groupSearch.trim() ? '未找到匹配的群' : '暂无会话'}
              </div>
            )}
          {kind === 'groupAssistant' && groupAssistantHasMore && groupAssistantError ? (
            <button
              type="button"
              className="weq-group-helper-more"
              onClick={onLoadMoreGroupAssistant}
            >
              {groupAssistantError ? '重试读取' : '继续读取群会话'}
            </button>
          ) : null}
        </div>
        {kind === 'groupAssistant' && selectionMode ? (
          <ConversationSelectionToolbar
            count={selectedIds.size}
            selectingAll={selectingAll}
            assistantCount={[...selectedIds].filter((id) => groupAssistantIds?.has(id)).length}
            allSelected={allSelected}
            onSelectAll={toggleAll}
            onExit={() => setSelectionMode(false)}
            exportReason={
              !selectedIds.size
                ? '请先选择会话'
                : !batch.exportAvailable
                  ? '当前无法导出会话'
                  : undefined
            }
            roamingReason={
              !selectedIds.size
                ? '请先选择会话'
                : !batch.roamingAvailable
                  ? '当前无法拉取漫游消息'
                  : undefined
            }
            onExport={() => batch.runExport([...selectedIds])}
            onRoaming={() => batch.runRoaming([...selectedIds])}
            readStateReason={
              directory?.readStateBusy
                ? '正在更新标记'
                : !selectedIds.size
                  ? '请先选择会话'
                  : selectedIds.size > 4096
                    ? '一次最多标记 4096 个会话'
                    : undefined
            }
            onReadState={
              directory?.onReadState
                ? (unread) => batch.runReadState([...selectedIds], unread)
                : undefined
            }
          />
        ) : null}
      </div>
      {actionMenu ? (
        <ConversationActionsMenu
          x={actionMenu.x}
          y={actionMenu.y}
          onClose={() => setActionMenu(null)}
          actions={[
            ...(directory?.onReadState
              ? [
                  {
                    label: batch.hasUnread(actionMenu.ids) ? '标为已读' : '标为未读',
                    icon: <MailOpen size={16} />,
                    disabled: directory.readStateBusy || actionMenu.ids.length > 4096,
                    action: () =>
                      batch.runReadState(actionMenu.ids, !batch.hasUnread(actionMenu.ids)),
                  },
                ]
              : []),
            {
              label: '多选',
              icon: <ListChecks size={16} />,
              action: () => {
                setSelectionMode(true);
                setSelectedIds(new Set(actionMenu.ids));
              },
            },
            ...(onGroupAssistantPin
              ? [
                  {
                    label: isAssistantPinned(actionMenu.conversation, groupAssistantPins)
                      ? '取消群助手内置顶'
                      : '在群助手内置顶',
                    icon: isAssistantPinned(actionMenu.conversation, groupAssistantPins) ? (
                      <PinOff size={16} />
                    ) : (
                      <Pin size={16} />
                    ),
                    action: () =>
                      onGroupAssistantPin(
                        actionMenu.conversation.id,
                        !isAssistantPinned(actionMenu.conversation, groupAssistantPins),
                      ),
                  },
                ]
              : []),
            ...(directory?.onAnalyze &&
            actionMenu.ids.length === 1 &&
            conversationAnalysisTarget(actionMenu.conversation)
              ? [
                  {
                    label: '分析',
                    icon: <BarChart3 size={16} />,
                    action: () => directory.onAnalyze?.(actionMenu.conversation),
                  },
                ]
              : []),
            ...(batch.exportAvailable
              ? [
                  {
                    label: '导出所选会话',
                    icon: <Download size={16} />,
                    action: () => batch.runExport(actionMenu.ids),
                  },
                ]
              : []),
            ...(batch.roamingAvailable
              ? [
                  {
                    label: '拉取所选会话漫游消息',
                    icon: <CloudDownload size={16} />,
                    action: () => batch.runRoaming(actionMenu.ids),
                  },
                ]
              : []),
          ]}
        />
      ) : null}
      {batch.confirmation}
    </div>
  );
}
