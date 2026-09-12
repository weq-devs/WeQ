import { X, EyeOff, Trash2 } from 'lucide-react';
import { useMemo, useEffect, useRef, useState } from 'react';
import { classifyChatType } from '@weq/codec';
import { Avatar } from '../../im-template/template/primitives';
import type { Conversation, MergedKind } from '../../im-template/template/types';
import { trpc } from '../../trpc/client';
import { resolveAvatar, avatarFromGroupCode } from '../../lib/avatarResolver';

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
  anchorX,
  anchorY,
  onBack,
  onSelectConversation,
  profileByUid,
  groupNameByCode,
}: MergedSessionPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: anchorX, y: anchorY });

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
  }, [anchorX, anchorY]);

  // 点击面板外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
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
  }, [onBack]);

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onBack();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onBack]);

  // 获取隐藏会话原始数据
  const hiddenSessions = trpc.account.listHiddenSessions.useQuery(undefined, {
    enabled: kind === 'hidden',
  });

  // 获取删除会话原始数据
  const deletedSessions = trpc.account.listDeletedSessions.useQuery(undefined, {
    enabled: kind === 'deleted',
  });

  const filtered = useMemo(() => {
    if (kind === 'deleted') {
      // 从 deletedSessions 数据构建会话列表
      if (!deletedSessions.data) return [];
      return deletedSessions.data
        .filter((deleted: DeletedSessionWire) => deleted.resolvable && deleted.targetUid)
        .map((deleted: DeletedSessionWire) => {
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
        .map((hidden: HiddenSessionWire) => {
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
      return officialAccounts.data.map((official: OfficialAccountSummaryWire) => {
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
      return serviceAccounts.data.map((service: ServiceAccountSummaryWire) => {
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
    deletedSessions.data,
    hiddenSessions.data,
    officialAccounts.data,
    serviceAccounts.data,
    profileByUid,
    groupNameByCode,
  ]);

  const sortedThreads = useMemo(
    () =>
      filtered.slice().sort((a, b) => {
        const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bTime - aTime;
      }),
    [filtered],
  );

  const title =
    kind === 'hidden'
      ? '隐藏的会话'
      : kind === 'deleted'
        ? '最近删除'
        : kind === 'service'
          ? 'QQ服务号'
          : 'QQ官方账号';

  return (
    <div className="weq-merged-overlay">
      <div
        ref={panelRef}
        className="weq-merged-popover"
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
        }}
      >
        <div className="weq-merged-popover-header">
          <div className="weq-merged-popover-title">{title}</div>
          <button type="button" className="weq-merged-popover-close" onClick={onBack}>
            <X size={16} />
          </button>
        </div>
        <div className="weq-merged-popover-body">
          {sortedThreads.map((conv) => {
            const preview = conv.lastMessage?.body ?? '';
            const time = conv.updatedAt
              ? new Date(conv.updatedAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';
            const name = conv.type === 'group' ? conv.group?.name : conv.otherUser?.displayName;
            const avatarUrl =
              conv.type === 'group' ? conv.group?.avatarUrl : conv.otherUser?.avatarUrl;
            const seed = conv.type === 'direct' ? conv.otherUser?.identityValue : conv.id;

            return (
              <button
                key={conv.id}
                type="button"
                className="weq-merged-popover-item"
                onClick={() => {
                  onSelectConversation(conv as Conversation);
                  onBack();
                }}
              >
                <Avatar name={name ?? ''} avatarUrl={avatarUrl} seed={seed ?? conv.id} />
                <div className="weq-merged-popover-item-main">
                  <div className="weq-merged-popover-item-top">
                    <div className="weq-merged-popover-item-name">{name}</div>
                    {time && <div className="weq-merged-popover-item-time">{time}</div>}
                  </div>
                  {preview && <div className="weq-merged-popover-item-preview">{preview}</div>}
                </div>
                {kind === 'hidden' && (
                  <EyeOff size={14} className="weq-merged-popover-item-badge" />
                )}
                {kind === 'deleted' && (
                  <Trash2 size={14} className="weq-merged-popover-item-badge" />
                )}
              </button>
            );
          })}
          {sortedThreads.length === 0 && <div className="weq-merged-popover-empty">暂无会话</div>}
        </div>
      </div>
    </div>
  );
}
