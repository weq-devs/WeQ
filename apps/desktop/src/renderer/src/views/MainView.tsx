/**
 * 主聊天视图。
 *
 * 这里把 WeQ 的 QQ 最近会话与消息 DTO 映射到 Webark IM Template 的
 * Conversation / Message 结构。数据读取仍走原来的 tRPC account router，
 * 页面外壳、会话列表和消息气泡由模板负责。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useUpdateStore } from '../state/update';
import { client } from '../trpc/client';
import { useDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { isDataline, deviceAvatarDataUri } from '../lib/deviceAvatar';
import { previewNodes, previewNodesToText } from '../lib/conversationPreview';
import { classifyChatType, datalineName, isDatalineSelfUid } from '@weq/codec';
import { useProfileResolver } from '../hooks/useProfileResolver';
import { useGroupMemberResolver } from '../hooks/useGroupMemberResolver';
import { useDressSkin } from '../hooks/useDressSkin';
import { RailAccountFooter } from '../components/RailAccountFooter';
import { SettingsDialog } from '../components/SettingsDialog';
import { CollectionDialog } from '../components/CollectionDialog';
import { DressUpDialog } from '../components/DressUpDialog';
import { MarketEmojiBrowserLightbox } from './export/MarketEmojiBrowserLightbox';
import { GroupAlbumDialog } from '../components/GroupAlbumDialog';
import { GroupFileDialog } from '../components/GroupFileDialog';
import { GroupAnalyticsDialog } from '../components/GroupAnalyticsDialog';
import {
  GroupAnnouncementsDialog,
  type GroupBulletinWire,
} from '../components/GroupAnnouncementsDialog';
import {
  GroupEssenceDialog,
  type GroupEssenceWire as GroupEssenceDisplay,
} from '../components/GroupEssenceDialog';
import { MemberProfileCard } from '../components/MemberProfileCard';
import { BuddyAnalyticsDialog } from '../components/BuddyAnalyticsDialog';
import { AddMessageModal } from '../components/compose/AddMessageModal';
import { DeletedMessagesModal } from '../components/compose/DeletedMessagesModal';
import { RecalledMessagesModal } from '../components/compose/RecalledMessagesModal';
import { RelationGraphView } from '../components/relationGraph/RelationGraphView';
import { SearchDropdown } from '../components/search/SearchDropdown';
import { UnifiedSearchModal } from '../components/search/UnifiedSearchModal';
import { ChatRecordsModal } from '../components/search/ChatRecordsModal';
import type {
  ChatRecordSearchHit,
  QuickSearchResult,
  SearchCategory,
  SearchHit,
  SlowSearchResult,
} from '../components/search/types';
import { AgentLabView } from './AgentLabView';
import { ExportView } from './ExportView';
import { CacheView } from './cache/CacheView';
import { QzoneView } from './QzoneView';
import { ChannelView } from './ChannelView';
import { ChatHome } from './ChatHome';
import {
  ChatMainContent,
  ChatShell,
  ChatSidebarContent,
  composeMessageRenderers,
  type Contact,
  type Conversation,
  type ConversationDrafts,
  type ConversationHighlight,
  type ConversationPreference,
  type ConversationPreferences,
  type GroupJoinRequest,
  type GroupMember,
  type GroupNoticeHandleState,
  type GroupUpdateInput,
  type Message,
  type MessageRenderer,
  type ProfileExtInfo,
  type User,
  useChatShellController,
} from '../im-template/template';
import {
  qqMessageRenderer,
  ReplyJumpContext,
  ForwardKindContext,
  ConvContext,
  type ReplyJumpTarget,
} from '../components/QqMessageContent';
import type { SetEmojiItem } from '@weq/codec';
import { MsgElementEditor } from '../components/MsgElementEditor';
import { flashTransferTitle } from '../components/QqFlashTransfer';
import { MergedSessionPanel } from '../components/sidebar/MergedSessionPanel';
import { ArkFeedView } from '../components/ArkFeedView';

const DATABASE_ISSUES_URL = 'https://github.com/H3CoF6/WeQ/issues';

function DatabaseDamagedDialogBody({
  message,
  details,
}: {
  message?: string;
  details?: string[];
}): ReactElement {
  const safeMessage = message ?? '';
  const safeDetails = details ?? [];
  const isHealthCheckError = safeMessage.includes('健康状态时发生错误');

  return (
    <div className="weq-db-damaged-dialog">
      <section className="weq-db-damaged-section">
        <h4>发生了什么</h4>
        <p>
          {isHealthCheckError ? '检测 QQ 数据库健康状态时发生错误。' : '检测到 QQ 数据库损坏。'}
        </p>
        <p>问题通常出在 QQ 数据库本身，不是 WeQ 软件导致。</p>
      </section>

      <section className="weq-db-damaged-section">
        <h4>已执行处理</h4>
        <p>
          {isHealthCheckError
            ? '为避免继续读取损坏数据，账号已强制退出并返回主页面。'
            : '账号已强制退出并返回主页面。'}
        </p>
      </section>

      <section className="weq-db-damaged-section">
        <h4>反馈与后续</h4>
        <p>
          可以前往{' '}
          <a href={DATABASE_ISSUES_URL} target="_blank" rel="noreferrer">
            WeQ GitHub Issues
          </a>{' '}
          提交问题，未来可能会做一个数据库修复工具。
        </p>
      </section>

      {safeDetails.length > 0 ? (
        <section className="weq-db-damaged-section weq-db-damaged-details">
          <h4>检测详情</h4>
          <ul>
            {safeDetails.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
              <li key={`${line}:${index}`}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

const messageRenderers: MessageRenderer[] = composeMessageRenderers({
  prepend: [qqMessageRenderer],
});

const PAGE_SIZE = 50;
const GROUP_MEMBER_PAGE_SIZE = 120;
/**
 * Cap for the live "re-read my loaded window" query. If a user scrolled up past
 * this many messages while still anchored to the latest, a refresh keeps only
 * the newest REFRESH_CAP — a rare edge, traded for a bounded re-render.
 */
const REFRESH_CAP = 500;

type RecentContactWire = {
  chatType: string | number;
  msgSeq: string;
  senderUid: string;
  targetUid: string;
  targetUin: string;
  sendTime: string;
  preview: unknown | null;
  senderDisplayName: string;
  senderNick: string;
  targetDisplayName: string;
  senderRemark: string;
  targetAvatar: string;
  targetRemark: string;
  /** 41148 — peer's group card; only set on temp c2c-from-group conversations. */
  targetGroupNick: string;
  /** 41220 — message-notify level. 1 = notify normally; else (observed 4) 免打扰/muted. */
  notifyLevel: number;
  /** 60001 — group code a temp c2c conversation started from; "0" when absent. */
  tempSourceGroupCode: string;
};

/** 置顶会话一行（recent_contact_top_table）。 */
type RecentContactTopWire = {
  chatType: string | number;
  /** 41103 — 置顶时间，unix 秒。 */
  topTime: string;
  /** 会话键：c2c 是对端 uid，群是群号 —— 对齐 RecentContactWire.targetUid。 */
  targetId: string;
};

/** 隐藏会话一行（hidden_session_storage_table_v1），最后消息时间/预览已由后端解析。 */
type HiddenSessionWire = {
  storageKey: string;
  chatType: string | number;
  targetUid: string;
  targetUin: string;
  resolvable: boolean;
  sendTime: string;
  senderUid: string;
  preview: unknown | null;
};

/** 删除会话一行（recent_contact_delete_storage），最后消息时间/预览已由后端解析。 */
type DeletedSessionWire = {
  sessionKey: string;
  chatType: number;
  targetUid: string;
  resolvable: boolean;
  sendTime: string;
  senderUid: string;
  preview: unknown | null;
  deleteTime: string;
};

/** 公众号摘要（listOfficialAccounts）—— wire 格式。 */
type OfficialAccountWire = {
  peerUid: string;
  displayName: string;
  targetUin: string;
  sendTime: string;
  prompt: string | null;
};

/** 服务号摘要（listServiceAccounts）—— wire 格式。 */
type ServiceAccountWire = {
  appId: string;
  displayName: string;
  avatarUrl: string | null;
  sendTime: string;
  prompt: string | null;
};

type MessageWire = {
  msgId: string;
  /** In-conversation sequence number (column 40003); the seq-window cursor. */
  msgSeq: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  elements: unknown[];
  /** Sticker reactions (贴表情, column 40062); group-only, omitted when none. */
  setEmojiList?: SetEmojiItem[];
  /** Deleted origin: 'weq' (restorable) or 'qq' (native recall, not). */
  deletedKind?: 'weq' | 'qq';
  /** Recall marker: message whose QQ recall was intercepted (content intact). */
  recall?: { revokeUid: string; sameSender: boolean; recallTs: number };
  /** Per-message decoration from column 40801 (0 = not set). */
  decoration?: { bubbleId: number; fontId: number; widgetId: number };
};


/** The unified chat-message wire from the account router → local MessageWire. */
type ChatMsgWire = {
  msgId: string;
  msgSeq: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  elements: unknown[];
  setEmojiList?: SetEmojiItem[];
  deletedKind?: 'weq' | 'qq';
  recall?: { revokeUid: string; sameSender: boolean; recallTs: number };
  decoration?: { bubbleId: number; fontId: number; widgetId: number };
};

function toMessageWire(w: ChatMsgWire): MessageWire {
  return {
    msgId: w.msgId,
    msgSeq: w.msgSeq,
    senderUid: w.senderUid,
    senderUin: w.senderUin,
    sendTime: w.sendTime,
    elements: w.elements,
    setEmojiList: w.setEmojiList,
    deletedKind: w.deletedKind,
    recall: w.recall,
    decoration: w.decoration,
  };
}

type UserProfileWire = {
  uid: string;
  qid: string;
  uin: string;
  nick: string;
  avatarUrl: string;
  birthYear: number;
  birthMonth: number;
  birthDay: number;
  gender: number;
  age: number;
  signature: string;
  remark: string;
  intimacy: number;
  sigUpdateTime: number;
  isFriend: boolean;
  customStatus?: {
    id?: number;
    desc?: string;
  };
  extRelation?: {
    preselectedIds: number[];
    displayId?: number;
  };
  extInfo?: ProfileExtInfo;
};

type GroupMemberWire = {
  groupCode?: string;
  uid: string;
  uin: string;
  card: string;
  nick: string;
  joinTime: number;
  lastSpeakTime?: number;
  muteUntil?: number;
  adminFlag: number;
  customTitle?: string;
  memberLevel?: number;
};

type BuddyWire = {
  uid: string;
  qid: string;
  uin: string;
  categoryId: number;
};

type CategoryWire = {
  id: number;
  name: string;
  buddyCount: number;
};

type BuddyRequestWire = {
  timestamp: number;
  peerUid: string;
  nick: string;
  verifyMsg: string;
  source: string;
  status: number;
  sourceGroupCode: string;
  initiator: number;
  isAccepted: number;
};

type GroupNotifyWire = {
  msgTime: number;
  status: number;
  verifyStatus: number;
  groupUin: string;
  groupName: string;
  operatedUid: string;
  operatedUin: string;
  operatedNick: string;
  operatorUid: string;
  operatorUin: string;
  operatorNick: string;
  opTime: number;
  remark: string;
  systemRemark: string;
  sourceTable: 'group_notify_list' | 'doubt_group_notify_list';
};

type GroupDetailWire = {
  groupCode: string;
  groupName: string;
  pinnedAnnounce: string;
  description: string;
  remark: string;
  ownerUid: string;
  createTime: number;
  maxMemberCount: number;
  memberCount: number;
  labels: string;
  entranceQ: string;
  customLabels: Array<{ content?: string }>;
  address?: { locationName?: string };
};

/** 数据库查询返回的原始群精华类型 */
type GroupEssenceWire = {
  msgSeq: number;
  senderNick: string;
  setStatus: number;
  operatorNick: string;
  timestamp: number;
};

type RenderElementWire = {
  type?: string;
  data?: Record<string, unknown>;
};

/** `account.getOnlineStatus` 的返回体（非 null 分支）。 */
type OnlineStatusWire = NonNullable<
  Awaited<ReturnType<typeof client.account.getOnlineStatus.query>>
>;

/** `account.getRawElements` 返回的原始 element 数组，喂给 MsgElementEditor。 */
type RawElementWire = NonNullable<
  Awaited<ReturnType<typeof client.account.getRawElements.query>>
>['elements'];

type PendingScrollRestore = {
  conversationId: string;
  previousHeight: number;
  previousTop: number;
};

type OverlayScrollbarState = {
  top: number;
  left: number;
  height: number;
  thumbTop: number;
  thumbHeight: number;
  visible: boolean;
  canScroll: boolean;
};

const overlayScrollbarInitialState: OverlayScrollbarState = {
  top: 0,
  left: 0,
  height: 0,
  thumbTop: 0,
  thumbHeight: 0,
  visible: false,
  canScroll: false,
};

const OVERLAY_SCROLLBAR_WIDTH = 10;
const OVERLAY_SCROLLBAR_INSET = 8;
const OVERLAY_SCROLLBAR_MIN_THUMB = 34;

const fallbackPreference: ConversationPreference = {
  pinned: false,
  muted: false,
  blocked: false,
};

const emptyDrafts: ConversationDrafts = {};

function groupAvatarSrc(groupCode: string): string | null {
  return groupCode ? `https://p.qlogo.cn/gh/${groupCode}/${groupCode}/0` : null;
}

/** Public-CDN avatar URL for a conversation (undefined -> template fallback). */
function avatarSrc(
  c: Pick<RecentContactWire, 'chatType' | 'targetUid' | 'targetUin'>,
): string | null {
  // C2C 必须先判：KCHATTYPETEMPC2CFROMGROUP 的名字里同时含 C2C 和 GROUP，先匹配
  // GROUP 会把对方 uid 当群号去拼 p.qlogo.cn，临时会话头像必裂。走 uin 外链才是真人头像。
  if (chatTypeKind(c.chatType) === 'direct') return senderAvatarSrc(c.targetUin);
  if (chatTypeKind(c.chatType) === 'group') return groupAvatarSrc(c.targetUid);
  return null;
}

function senderAvatarSrc(uin: string): string | null {
  if (!uin || uin === '0') return null;
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
}

function secondsToIsoTime(seconds: number | string | undefined): string | null {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function millisecondsToIsoTime(ms: number | string | undefined): string | null {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function chatTypeKind(chatType: string | number): 'direct' | 'group' | null {
  const kind = classifyChatType(chatType);
  // 数据线（我的手机/我的电脑）按单聊解析，头像用设备图标兜底（isDataline()）。
  if (kind === 'direct' || kind === 'dataline') return 'direct';
  if (kind === 'group') return 'group';
  return null;
}

function toIsoTime(seconds: string | undefined): string {
  return secondsToIsoTime(seconds) ?? new Date(0).toISOString();
}

function contactTitle(c: RecentContactWire): string {
  // 私聊优先显示备注：40095 是「发送者」维度的列，群会话里存的是发言人的好友备注
  // （群名在 40094），所以只在单聊/临时会话上认它。41148 是对方在共同群里的群名片，
  // 群聊发起的临时会话往往只有它才是人能认出的名字。
  const remark = chatTypeKind(c.chatType) === 'direct' ? c.senderRemark || c.targetGroupNick : '';
  return (
    remark ||
    c.targetDisplayName ||
    c.targetRemark ||
    c.senderDisplayName ||
    c.senderNick ||
    // 数据线会话往往不带 targetDisplayName，会回退成原始 uid；优先给出设备名。
    datalineName(c.targetUid) ||
    c.targetUid
  );
}

function currentUser(openedUin: string | null, selfProfile?: UserProfileWire | null): User {
  const identityValue = openedUin ?? 'unknown';
  return {
    id: `self:${identityValue}`,
    identityLabel: 'UIN',
    identityValue,
    username: `uin-${identityValue}`,
    displayName: selfProfile?.nick || 'WeQ',
    // Prefer the uin-derived CDN avatar (always resolvable) over the profile
    // DB's stored URL, which is frequently empty or a stale signed link.
    avatarUrl: senderAvatarSrc(identityValue) || selfProfile?.avatarUrl || null,
    signature: selfProfile?.signature || null,
  };
}

function displayProfileName(profile?: UserProfileWire): string | null {
  if (!profile) return null;
  return profile.remark || profile.nick || profile.qid || profile.uin || null;
}

function _genderLabel(value?: number): string | null {
  if (value === 1) return '男';
  if (value === 2) return '女';
  return null;
}

function buddyToContact(
  buddy: BuddyWire,
  profileByUid: Map<string, UserProfileWire>,
  categoryById: Map<number, CategoryWire>,
  botUids: Set<string>,
): Contact {
  const profile = profileByUid.get(buddy.uid);
  const displayName = displayProfileName(profile) || buddy.qid || buddy.uin || buddy.uid;
  const category = categoryById.get(buddy.categoryId);
  const customStatus = profile?.customStatus?.desc?.trim() || null;

  return {
    id: buddy.uid,
    identityLabel: buddy.uin && buddy.uin !== '0' ? 'QQ' : 'UID',
    identityValue: buddy.uin && buddy.uin !== '0' ? buddy.uin : buddy.uid,
    username: buddy.uid,
    displayName,
    kind: botUids.has(buddy.uid) ? 'bot' : 'human',
    avatarUrl: senderAvatarSrc(buddy.uin) || profile?.avatarUrl || null,
    signature: profile?.signature || null,
    createdAt: new Date(0).toISOString(),
    categoryId: buddy.categoryId,
    categoryName: category?.name || null,
    qid: buddy.qid || profile?.qid || null,
    nick: profile?.nick || null,
    remark: profile?.remark || null,
    age: profile?.age,
    gender: profile?.gender,
    birthYear: profile?.birthYear,
    birthMonth: profile?.birthMonth,
    birthDay: profile?.birthDay,
    intimacy: profile?.intimacy,
    extRelation: profile?.extRelation ?? null,
    extInfo: profile?.extInfo ?? null,
    customStatus,
    onlineStatus: customStatus,
  };
}

function groupDetailToConversation(
  detail: GroupDetailWire,
  fallback?: Conversation | null,
  user?: User,
): Conversation {
  // 没有 recent_contact 行时（群在列表里被删过 / 从没收发过消息）不拿群创建时间
  // 顶替「最后消息时间」——两者语义无关，曾经导致这类群按创建时间在会话列表里
  // 乱序（新建的群创建时间很新，会插到本该排最后的位置）。退化成最旧，交给排序
  // 沉底，与 lastMessage 仍是 null 的事实一致。
  const updatedAt = fallback?.updatedAt ?? new Date(0).toISOString();
  const group = fallback?.type === 'group' ? fallback.group : null;

  return {
    id: detail.groupCode,
    type: 'group',
    updatedAt,
    otherUser: null,
    group: {
      id: detail.groupCode,
      name: detail.groupName || group?.name || detail.groupCode,
      identityLabel: 'Group',
      identityValue: detail.groupCode,
      avatarUrl: group?.avatarUrl || groupAvatarSrc(detail.groupCode),
      announcement: detail.pinnedAnnounce || group?.announcement || null,
      description: detail.description || null,
      remark: detail.remark || null,
      memberCount: detail.memberCount || group?.memberCount || 0,
      maxMemberCount: detail.maxMemberCount || undefined,
      role: group?.role || 'member',
      createTime: secondsToIsoTime(detail.createTime),
      labels: detail.labels || null,
      entranceQ: detail.entranceQ || null,
      customLabels: detail.customLabels
        .map((label) => label.content)
        .filter((label): label is string => Boolean(label)),
      addressName: detail.address?.locationName || null,
    },
    members:
      fallback?.type === 'group'
        ? fallback.members
        : user
          ? [{ ...user, role: 'member', joinedAt: updatedAt }]
          : [],
    preference: fallback?.preference ?? fallbackPreference,
    unreadCount: fallback?.unreadCount ?? 0,
    lastMessage: fallback?.lastMessage ?? null,
  };
}

function requestStatus(status: number): 'pending' | 'accepted' | 'rejected' | 'cancelled' {
  if (status === 2) return 'accepted';
  if (status === 13) return 'cancelled';
  return 'pending';
}

function buddyRequestToContactRequest(
  request: BuddyRequestWire,
  profileByUid: Map<string, UserProfileWire>,
) {
  const profile = profileByUid.get(request.peerUid);
  const uin = profile?.uin ?? '';
  const contact: Contact = {
    id: request.peerUid,
    identityLabel: uin && uin !== '0' ? 'QQ' : 'UID',
    identityValue: uin && uin !== '0' ? uin : request.peerUid,
    username: request.peerUid,
    displayName: profile?.nick || profile?.remark || request.nick || request.peerUid,
    avatarUrl: senderAvatarSrc(uin) || profile?.avatarUrl || null,
    signature: profile?.signature || null,
    createdAt: secondsToIsoTime(request.timestamp) ?? new Date(0).toISOString(),
  };

  return {
    id: `buddy-request:${request.peerUid}:${request.timestamp}`,
    direction: request.isAccepted === 0 ? 'incoming' : 'outgoing',
    status: requestStatus(request.status),
    message: request.verifyMsg || null,
    createdAt: contact.createdAt,
    respondedAt: null,
    user: contact,
  } as const;
}

/** 61002 —— 这条群通知在说什么事。 */
const GROUP_NOTIFY_ACTION: Record<number, string> = {
  1: '申请加入',
  3: '被设置为管理员',
  6: '被移出群聊',
  11: '被管理员拒绝加入',
  13: '退出了群聊',
  15: '被取消管理员权限',
};

/** 61003 —— 这条通知的处理状态。 */
const GROUP_NOTIFY_HANDLE_STATE: Record<number, GroupNoticeHandleState> = {
  0: 'none',
  1: 'pending',
  2: 'agreed',
  3: 'refused',
};

/** notify 里的一个人（申请人 / 处理人）→ Contact。uin 由 service 层查库补齐。 */
function groupNotifyUserToContact(
  uid: string,
  uin: string,
  nick: string,
  profileByUid: Map<string, UserProfileWire>,
  createdAt: string,
): Contact {
  const profile = profileByUid.get(uid);
  const hasUin = (v: string | undefined): v is string => !!v && v !== '0';
  const resolvedUin = hasUin(uin) ? uin : hasUin(profile?.uin) ? profile.uin : '';
  return {
    id: uid,
    identityLabel: resolvedUin ? 'QQ' : 'UID',
    identityValue: resolvedUin || uid,
    username: uid,
    displayName: nick || profile?.remark || profile?.nick || resolvedUin || uid,
    avatarUrl: senderAvatarSrc(resolvedUin) || profile?.avatarUrl || null,
    signature: profile?.signature || null,
    createdAt,
  };
}

function groupNotifyToGroupRequest(
  notify: GroupNotifyWire,
  profileByUid: Map<string, UserProfileWire>,
  groupsById: Map<string, Conversation>,
): GroupJoinRequest | null {
  const groupConversation = groupsById.get(notify.groupUin);
  if (groupConversation?.type !== 'group') return null;

  const createdAt = millisecondsToIsoTime(notify.msgTime) ?? new Date(0).toISOString();
  const user = groupNotifyUserToContact(
    notify.operatedUid,
    notify.operatedUin,
    notify.operatedNick,
    profileByUid,
    createdAt,
  );
  const handleState = GROUP_NOTIFY_HANDLE_STATE[notify.verifyStatus] ?? 'none';
  // 处理人只在真的有人处理过时才有意义 —— 未处理的申请里 61007 可能残留邀请人。
  const operator =
    notify.operatorUid && (handleState === 'agreed' || handleState === 'refused')
      ? groupNotifyUserToContact(
          notify.operatorUid,
          notify.operatorUin,
          notify.operatorNick,
          profileByUid,
          createdAt,
        )
      : null;

  return {
    id: `group-notify:${notify.groupUin}:${notify.operatedUid}:${notify.msgTime}`,
    handleState,
    action: GROUP_NOTIFY_ACTION[notify.status] ?? '群通知',
    message: notify.remark || null,
    systemRemark: notify.systemRemark || null,
    createdAt,
    respondedAt: notify.opTime > 0 ? secondsToIsoTime(notify.opTime) : null,
    group: {
      id: groupConversation.group.id,
      conversationId: groupConversation.id,
      identityLabel: groupConversation.group.identityLabel,
      identityValue: groupConversation.group.identityValue,
      name: notify.groupName || groupConversation.group.name,
      avatarUrl: groupConversation.group.avatarUrl,
      announcement: groupConversation.group.announcement,
      memberCount: groupConversation.group.memberCount,
    },
    user,
    operator,
    isDoubt: notify.sourceTable === 'doubt_group_notify_list',
  };
}

function _groupRequestFromBuddyRequest(
  request: BuddyRequestWire,
  groupsById: Map<string, Conversation>,
  profileByUid: Map<string, UserProfileWire>,
) {
  if (!request.sourceGroupCode || request.sourceGroupCode === '0') return null;
  const groupConversation = groupsById.get(request.sourceGroupCode);
  if (groupConversation?.type !== 'group') return null;
  const contactRequest = buddyRequestToContactRequest(request, profileByUid);

  return {
    id: `group-request:${request.sourceGroupCode}:${request.peerUid}:${request.timestamp}`,
    direction: contactRequest.direction,
    status: contactRequest.status,
    message: contactRequest.message,
    createdAt: contactRequest.createdAt,
    respondedAt: null,
    group: {
      id: groupConversation.group.id,
      conversationId: groupConversation.id,
      identityLabel: groupConversation.group.identityLabel,
      identityValue: groupConversation.group.identityValue,
      name: groupConversation.group.name,
      avatarUrl: groupConversation.group.avatarUrl,
      announcement: groupConversation.group.announcement,
      memberCount: groupConversation.group.memberCount,
    },
    user: contactRequest.user,
  } as const;
}

function levelBracketFor(level?: number): number {
  if (level === undefined) return 0;
  if (level <= 10) return 1;
  if (level <= 20) return 2;
  if (level <= 40) return 3;
  if (level <= 60) return 4;
  if (level <= 80) return 5;
  return 6;
}

function levelNameFor(
  levelConfigs: Array<{ level: number; levelName: string }>,
  level?: number,
): string | null {
  if (level === undefined || level === 0) return null;
  const bracket = levelBracketFor(level);
  return levelConfigs.find((item) => item.level === bracket)?.levelName || `Lv${level}`;
}

/**
 * Derive the 免打扰/muted flag from `recent_contact` column 41220.
 * Observed values: 1 = notify normally, 4 = muted. Treat 0/1 as "notify"
 * (0 = unset) and anything else (2/3/4 — QQ's various push-restriction modes)
 * as muted, so the conversation shows the grey badge + disabled-bell indicator.
 */
function mutedFromNotifyLevel(notifyLevel: number | undefined): boolean {
  return notifyLevel !== undefined && notifyLevel !== 0 && notifyLevel !== 1;
}

/**
 * 群聊发起的临时会话的来源群名（60001 是原始群号）。群不在我的群列表里（退群 /
 * 从未加入）时退化为群号，至少还能认出是哪个群。
 */
function tempSourceGroupName(
  c: RecentContactWire,
  groupNameByCode: Map<string, string>,
): string | null {
  const code = c.tempSourceGroupCode;
  if (!code || code === '0') return null;
  return groupNameByCode.get(code) || code;
}

function contactToConversation(
  c: RecentContactWire,
  user: User,
  groupNameByCode: Map<string, string>,
  botUids: Set<string>,
): Conversation | null {
  const kind = chatTypeKind(c.chatType);
  const title = contactTitle(c);
  const nodes = previewNodes(c.preview);
  const preview = previewNodesToText(nodes) || null;
  const updatedAt = toIsoTime(c.sendTime);
  const preference: ConversationPreference = {
    ...fallbackPreference,
    muted: mutedFromNotifyLevel(c.notifyLevel),
  };
  const lastMessage = {
    id: `preview:${c.targetUid}:${c.sendTime}`,
    senderId: c.senderUid || null,
    senderDisplayName: c.senderDisplayName || c.senderNick || null,
    body: preview,
    previewNodes: nodes.length ? nodes : null,
    createdAt: updatedAt,
  };

  if (kind === 'direct') {
    const otherUser: User = {
      id: c.targetUid,
      identityLabel: c.targetUin && c.targetUin !== '0' ? 'QQ' : 'UID',
      identityValue: c.targetUin && c.targetUin !== '0' ? c.targetUin : c.targetUid,
      username: c.targetUid,
      displayName: title,
      kind: botUids.has(c.targetUid) ? 'bot' : 'human',
      avatarUrl: isDataline(c.chatType) ? deviceAvatarDataUri(c.targetUid) : avatarSrc(c),
    };

    return {
      id: c.targetUid,
      type: 'direct',
      updatedAt,
      otherUser,
      group: null,
      members: [],
      preference,
      unreadCount: 0,
      lastMessage,
      chatType: c.chatType,
      tempSourceGroupName: tempSourceGroupName(c, groupNameByCode),
    };
  }

  if (kind === 'group') {
    return {
      id: c.targetUid,
      type: 'group',
      updatedAt,
      otherUser: null,
      group: {
        id: c.targetUid,
        name: title,
        identityLabel: 'Group',
        identityValue: c.targetUid,
        avatarUrl: avatarSrc(c),
        announcement: null,
        memberCount: 1,
        role: 'member',
      },
      members: [{ ...user, role: 'member', joinedAt: updatedAt }],
      preference,
      unreadCount: 0,
      lastMessage,
    };
  }

  return null;
}

/**
 * Decide whether a wire message was sent by the current user.
 *
 * Primary signal is `senderUin === user.identityValue` — exact match against
 * the logged-in account's uin, which QQ NT sets on every outbound message in
 * both c2c and group chats.
 *
 * The legacy `data.isSender === true` fallback exists ONLY for messages where
 * `senderUin` is missing (historical receive paths). It is UNSAFE to trust
 * otherwise: a `multiMsg` (合并转发) carrier element itself carries
 * `isSender=true` in the local DB, and that flag does NOT reflect the carrier
 * message's own direction. Reading it at the top level misclassifies a forward
 * the peer sent you as "sent by me" (both c2c and group). So whenever a valid
 * `senderUin` is present we decide direction from it alone and never consult
 * `isSender`; the fallback is reached only when `senderUin` is absent/'0'.
 */
function isMineMessage(message: MessageWire, conversation: Conversation, user: User): boolean {
  // 数据线：senderUin 是自己（各设备同号），无法区分方向；约定 PC 伪 uid = 本机，
  // 由它发出的算"我发的"，手机/平板发来的算对端。这些伪 uid 只在数据线会话命中，
  // 对普通好友/群成员 uid 返回 false，故可安全地放在最前面。
  if (isDatalineSelfUid(message.senderUid)) return true;
  if (datalineName(message.senderUid)) return false;
  // senderUin 有效（存在且非哨兵 '0'）时以它为准判定方向，不再信任 element.isSender。
  if (message.senderUin && message.senderUin !== '0') {
    return message.senderUin === user.identityValue;
  }
  // senderUin 缺失时才 fallback 到 element 标志（旧/迁移消息兜底），仅限私聊。
  if (conversation.type !== 'direct') return false;
  return message.elements.some((element) => {
    const data = (element as RenderElementWire | null)?.data;
    return data?.isSender === true;
  });
}

function messageSender(
  message: MessageWire,
  conversation: Conversation,
  user: User,
  memberMap?: Map<string, GroupMember>,
  botUids?: Set<string>,
): User {
  const isMine = isMineMessage(message, conversation, user);
  if (isMine && conversation.type === 'direct') return user;

  // For group messages, even if it's mine, get member info from memberMap
  if (conversation.type === 'group') {
    const member = memberMap?.get(message.senderUid);
    const isUinOnly = !member;

    return {
      id: isMine ? user.id : message.senderUid || `sender:${message.senderUin}`,
      identityLabel: isMine
        ? user.identityLabel
        : message.senderUin && message.senderUin !== '0'
          ? 'QQ'
          : 'UID',
      identityValue: isMine
        ? user.identityValue
        : message.senderUin && message.senderUin !== '0'
          ? message.senderUin
          : message.senderUid,
      username: isMine ? user.username : message.senderUid || message.senderUin,
      displayName: isMine
        ? user.displayName
        : member?.displayName ||
          (message.senderUin && message.senderUin !== '0' ? message.senderUin : 'Member'),
      avatarUrl: isMine ? user.avatarUrl : member?.avatarUrl || senderAvatarSrc(message.senderUin),
      kind: !isMine && botUids?.has(message.senderUid) ? 'bot' : 'human',
      role: !isUinOnly ? member?.role : undefined,
      customTitle: !isUinOnly ? member?.customTitle : undefined,
      levelName: !isUinOnly ? member?.levelName : undefined,
      memberLevel: !isUinOnly ? member?.memberLevel : undefined,
      levelBracket: !isUinOnly ? levelBracketFor(member?.memberLevel) : 0,
    } as User;
  }

  if (isMine) return user;
  return conversation.type === 'direct' ? conversation.otherUser : user;
}

function messageToTemplate(
  message: MessageWire,
  conversation: Conversation,
  user: User,
  memberMap?: Map<string, GroupMember>,
  botUids?: Set<string>,
): Message {
  const sender = messageSender(message, conversation, user, memberMap, botUids);
  // For any `reply` element in the message, resolve the ORIGINAL message
  // sender's display name (memberMap → self → otherUser → uin/uid fallbacks)
  // and stash it on the reply's data as `origSenderDisplayName` so
  // QqMessageContent's ReplyQuote can render it on the quote box's first line
  // without having to thread the renderer-side group lookup through React
  // context. Non-reply elements are passed through untouched.
  const elements = enrichReplyElements(message.elements, conversation, user, memberMap);
  // Recall reviser's display name: only needed when an admin recalled someone
  // else's message (sameSender === false). Group → memberMap by uid; c2c → the
  // peer (the only other party). Falls back to a generic label in the bubble.
  let recallRevokerName: string | undefined;
  if (message.recall && !message.recall.sameSender) {
    const uid = message.recall.revokeUid;
    if (uid) {
      recallRevokerName =
        memberMap?.get(uid)?.displayName ??
        (conversation.type === 'direct' && conversation.otherUser.id === uid
          ? conversation.otherUser.displayName
          : undefined);
    }
  }
  return {
    id: message.msgId,
    conversationId: conversation.id,
    senderId: sender.id,
    sender,
    body: messageBody(message.elements),
    createdAt: toIsoTime(message.sendTime),
    // Raw render-view elements for the QQ face renderer (qqFaceMessageRenderer).
    // `body` stays the text fallback for previews and non-face messages.
    qqElements: elements,
    // Sticker reactions (贴表情) rendered below the bubble by MessageBubble.
    setEmojiList: message.setEmojiList,
    // Deleted origin ('weq'/'qq'), carried to the bubble's veil renderer.
    deletedKind: message.deletedKind,
    // Recall marker + resolved reviser name, carried to the bubble's 撤回 tag.
    recall: message.recall,
    recallRevokerName,
    msgId: message.msgId,
    // Per-conversation sequence, carried through so chatPane can spot the gaps
    // where messages QQ never synced locally would have been.
    msgSeq: message.msgSeq,
    // Per-message decoration (bubble/font/widget itemIds from column 40801).
    decoration: message.decoration,
  } as Message & {
    qqElements: unknown[];
    setEmojiList?: SetEmojiItem[];
    deletedKind?: 'weq' | 'qq';
    recall?: { revokeUid: string; sameSender: boolean; recallTs: number };
    recallRevokerName?: string;
    msgId: string;
    msgSeq: string;
    decoration?: { bubbleId: number; fontId: number; widgetId: number };
  };
}

/**
 * Resolve `origSenderUid` (or `origSenderUin`) on every reply element to a
 * human-readable nick. Mirrors `messageSender`'s preference order so the quote
 * box matches the bubble header: memberMap > self > otherUser > uin > uid.
 * Non-reply elements are returned by reference (no copy).
 */
function enrichReplyElements(
  elements: unknown[],
  conversation: Conversation,
  user: User,
  memberMap?: Map<string, GroupMember>,
): unknown[] {
  if (!Array.isArray(elements) || elements.length === 0) return elements;
  let mutated = false;
  const out = elements.map((element) => {
    if (!element || typeof element !== 'object') return element;
    const el = element as RenderElementWire;
    if (el.type !== 'reply') return element;
    const data = (el.data ?? {}) as Record<string, unknown>;
    const nick = resolveOrigSenderNick(data, conversation, user, memberMap);
    if (!nick) return element;
    mutated = true;
    return { ...el, data: { ...data, origSenderDisplayName: nick } };
  });
  return mutated ? out : elements;
}

function resolveOrigSenderNick(
  data: Record<string, unknown>,
  conversation: Conversation,
  user: User,
  memberMap?: Map<string, GroupMember>,
): string | null {
  const uid = typeof data.origSenderUid === 'string' ? data.origSenderUid : '';
  const uinRaw = data.origSenderUin;
  const uin =
    typeof uinRaw === 'number' ? String(uinRaw) : typeof uinRaw === 'string' ? uinRaw : '';

  // 1) Self — match by uin against the logged-in account's identityValue.
  // (`user.id` is `self:${uin}` so a uid-string comparison never matches.)
  if (uin && uin !== '0' && uin === user.identityValue) {
    return user.displayName || null;
  }

  // 2) Group member directory — uid-keyed; the same map messageSender uses.
  if (uid) {
    const member = memberMap?.get(uid);
    const memberName = member?.displayName;
    if (memberName && memberName !== uin) return memberName;
  }

  // 3) c2c — only two participants. If we already ruled out self in step 1,
  // by elimination the original sender of any quoted message in this direct
  // chat IS the peer. Skip the uid/uin equality dance (origSender* fields
  // are unreliable on c2c: QQ NT often leaves origSenderUid empty and the
  // uin can land as 0 for older quotes).
  if (conversation.type === 'direct') {
    return conversation.otherUser.displayName || null;
  }

  // 4) Fall back to uin (numeric QQ) — readable in the UI even if no profile
  // has been resolved yet. Last resort: the uid string itself.
  if (uin && uin !== '0') return uin;
  if (uid) return uid;
  return null;
}

function messageBody(elements: unknown[]): string {
  const parts = elements.map(elementText).filter(Boolean);
  return parts.length > 0 ? parts.join('') : '';
}

/**
 * All element kinds defined in @weq/codec's element/spec.ts EXCEPT `unknown`.
 * Keep this list in sync with codec when new element kinds are added — a
 * message carrying any of these is considered renderable (dedicated component,
 * qqMessageRenderer claim, or body text fallback), so it must NOT be filtered
 * out by isRenderableMessage. `unknown` is intentionally excluded: it is the
 * codec's "we didn't recognize this" tag, and a message that contains only
 * `unknown` elements is exactly what we want to drop + log.
 */
const RENDERABLE_ELEMENT_TYPES = new Set<string>([
  // Basic text & mention.
  'text',
  'at',
  // Rich media (handled by qqMessageRenderer / dedicated media components).
  'pic',
  'file',
  'video',
  'bubbleVideo',
  'ptt',
  'face',
  'mface',
  // Reply quote.
  'reply',
  // Gray tips (dedicated components in chatPane.tsx).
  'grayTipRevoke',
  'grayTipPoke',
  'grayTipGroup',
  'grayTipXml',
  // Rich content (some already render as body text; markdown/ark to be wired up).
  'ark',
  'markdown',
  'multiMsg',
  'call',
  'wallet',
  // 机器人内联键盘（与 markdown 正文成对出现）。
  'inlineKeyboard',
  // Cloud storage links.
  'onlineFile',
  'onlineFolder',
  // Misc.
  'emojiBounce',
  'qqDynamic',
  'shareLocation',
  // Gray tips that carry no gray-tip fields: FILE (subType=10) reuses the FILE
  // tag block, AIO_OP (subType=15) only names the group a temp session came from.
  'grayTipFileRecv',
  'grayTipTempSession',
]);

/**
 * Drop messages that produce nothing on screen: no dedicated gray-tip
 * component, nothing for qqMessageRenderer, and no fallback body text. These
 * used to render as a "[Unsupported message]" bubble — we now log them and
 * skip the bubble entirely. (Note: messages with at least one renderable
 * element still pass even if other elements are unknown.)
 */
function isRenderableMessage(message: MessageWire): boolean {
  const elements = message.elements ?? [];
  const hasRenderableElement = elements.some((el) => {
    const type = (el as RenderElementWire | null)?.type;
    return typeof type === 'string' && RENDERABLE_ELEMENT_TYPES.has(type);
  });
  if (hasRenderableElement) return true;
  if (messageBody(elements) !== '') return true;
  console.warn('[unsupported-message] dropping message with no renderable content', {
    msgId: message.msgId,
    msgSeq: message.msgSeq,
    senderUid: message.senderUid,
    elementTypes: elements.map((el) => (el as RenderElementWire | null)?.type ?? null),
  });
  return false;
}

/**
 * Collect group-member uids referenced INSIDE gray-tip element payloads (poke
 * XML / invite XML / mute info) so the member resolver can pre-fetch their
 * nicks the same way it does for message senders. Only `u_`-prefixed uids are
 * returned — numeric uins can't be resolved via getGroupMembersByUids and
 * would otherwise be re-fetched forever (never landing in the resolved cache).
 */
function extractGrayTipUids(elements: unknown[]): string[] {
  const uids: string[] = [];
  const pushUid = (value: unknown) => {
    if (typeof value === 'string' && value.startsWith('u_')) uids.push(value);
  };

  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const { type, data = {} } = element as RenderElementWire;

    if (type === 'grayTipPoke' || type === 'grayTipXml') {
      const xml = typeof data.grayTipXmlContent === 'string' ? data.grayTipXmlContent : '';
      if (xml) {
        const re = /uin="([^"]+)"/g;
        let match = re.exec(xml);
        while (match !== null) {
          pushUid(match[1]);
          match = re.exec(xml);
        }
      }
      const tipJson = typeof data.tipJson === 'string' ? data.tipJson : '';
      if (tipJson) {
        try {
          const parsed = JSON.parse(tipJson);
          for (const item of parsed.items ?? []) pushUid(item?.uin);
        } catch {
          /* malformed tipJson — nothing to extract */
        }
      }
    } else if (type === 'grayTipGroup') {
      const mute = data.muteInfo as
        | { operator?: { uid?: unknown }; mutedUser?: { uid?: unknown } }
        | undefined;
      pushUid(mute?.operator?.uid);
      pushUid(mute?.mutedUser?.uid);
    } else if (type === 'grayTipRevoke') {
      // Placeholder / offline recall tips often arrive WITHOUT the sender's nick
      // baked in — only the uids. Pre-resolve them via the group-member resolver
      // so GrayTipRevokeMessage can show "{昵称} 撤回了一条消息" instead of a
      // bare placeholder. (Both are `u_`-prefixed; pushUid filters accordingly.)
      pushUid(data.recallSenderUid);
      pushUid(data.recallRevokeUid);
    }
  }

  return uids;
}

function elementText(element: unknown): string {
  if (!element || typeof element !== 'object') return '';
  const { type, data = {} } = element as RenderElementWire;

  switch (type) {
    case 'text':
    case 'at':
      return stringField(data, 'textContent');
    case 'face':
      return stringField(data, 'faceText') || stringField(data, 'faceExtDesc') || '[Emoji]';
    case 'pic':
      return attachmentText('Image', data, 'fileName', 'summary');
    case 'file':
      return attachmentText('File', data, 'fileName');
    case 'onlineFile':
      return attachmentText('在线文件', data, 'fileName');
    case 'onlineFolder':
      return attachmentText('在线文件夹', data, 'fileName');
    case 'video':
      return attachmentText('Video', data, 'fileName', 'summary');
    case 'ptt':
      return attachmentText('Voice', data, 'fileName', 'summary');
    case 'reply':
      return quoteText('Reply', data, 'replyTextSummary');
    case 'grayTipRevoke':
      return stringField(data, 'recallDisplayText') || '[Message recalled]';
    case 'grayTipPoke':
      return stringField(data, 'grayTipXmlContent') || stringField(data, 'tipJson') || '[Poke]';
    case 'grayTipGroup': {
      const muteDuration = data.muteDuration as number | undefined;
      const user1 =
        (data.user1GroupNick as string | undefined) || (data.user1Nick as string | undefined);
      const user2 =
        (data.user2GroupNick as string | undefined) || (data.user2Nick as string | undefined);
      const hasMutedUser = data.mutedUserInfo !== undefined;

      if (muteDuration !== undefined && user1) {
        if (hasMutedUser && user2) {
          return muteDuration > 0 ? `${user2} 被 ${user1} 禁言` : `${user1} 结束了 ${user2} 的禁言`;
        }
        return muteDuration > 0 ? `${user1} 开启了全员禁言` : `${user1} 关闭了全员禁言`;
      }
      if (data.groupTipType === 1 && user1) {
        return `${user1} 加入了群聊`;
      }
      if (data.groupTipType === 2) {
        return '该群已被群主解散';
      }
      if (data.groupTipType === 3 && user1) {
        return `${user1} 已将你移出群聊`;
      }
      return '[Group notice]';
    }
    case 'ark':
      return arkPreview(stringField(data, 'arkData'));
    case 'markdown': {
      // QQ 闪传 card → clean label instead of the raw `[闪传](mqqapi://…)` link.
      const flashInfo = data.flashTransferInfo;
      if (flashInfo && typeof flashInfo === 'object' && Object.keys(flashInfo).length > 0) {
        const title = flashTransferTitle(stringField(data, 'markdownContent'));
        return title ? `[QQ闪传] ${title}` : '[QQ闪传]';
      }
      return (
        stringField(data, 'markdownContent') ||
        stringField(data, 'markdownTextSummary') ||
        '[Markdown]'
      );
    }
    case 'multiMsg':
      return '[Merged messages]';
    case 'call':
      return arraySummary(data, 'callSummary') || '[Call]';
    case 'wallet': {
      const detail = (data.walletDetail ?? {}) as Record<string, unknown>;
      const type = Number(detail.redbagType ?? data.walletRedbagType);
      const title = typeof detail.redbagTitle === 'string' ? detail.redbagTitle : '';
      if (type === 1) return title ? `[转账] ${title}` : '[转账]';
      return title ? `[QQ红包] ${title}` : '[QQ红包]';
    }
    case 'mface':
      return '[Sticker]';
    case 'emojiBounce':
      return (
        stringField(data, 'emojiBounceTextSummary') ||
        stringField(data, 'emojiBouncePcText') ||
        '[Emoji interaction]'
      );
    case 'qqDynamic': {
      const desc = (data.dynamicDesc ?? {}) as Record<string, unknown>;
      const main = typeof desc.mainDesc === 'string' ? desc.mainDesc : '';
      return main ? `[QQ动态] ${main}` : '[QQ动态]';
    }
    case 'shareLocation':
      return stringField(data, 'shareLocationText') || '[位置共享]';
    case 'grayTipFileRecv': {
      const name = stringField(data, 'fileName');
      return name ? `[文件传输完成: ${name}]` : '[文件传输完成]';
    }
    case 'grayTipTempSession': {
      const code = stringField(data, 'tempSessionGroupCode');
      return code ? `[临时会话] 来自群 ${code}` : '[临时会话]';
    }
    case 'unknown':
      console.warn('[unsupported-element] unknown element type encountered', data);
      return '';
    default:
      return '';
  }
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

function arraySummary(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (!Array.isArray(value)) return '';
  return value.filter((item): item is string => typeof item === 'string').join(' ');
}

function attachmentText(
  label: string,
  data: Record<string, unknown>,
  nameKey: string,
  summaryKey?: string,
): string {
  const summary = summaryKey ? arraySummary(data, summaryKey) : '';
  const name = stringField(data, nameKey);
  return summary || (name ? `[${label}] ${name}` : `[${label}]`);
}

function quoteText(label: string, data: Record<string, unknown>, key: string): string {
  const text = stringField(data, key);
  return text ? `> ${text}` : `[${label}]`;
}

/**
 * Short, human-friendly preview text for an `ark` card (used by the
 * conversation-list last-message line). Prefers the share's `prompt`, then a
 * title-ish field off the first meta payload, falling back to a generic tag.
 */
function arkPreview(raw: string): string {
  if (!raw) return '[卡片消息]';
  try {
    const ark = JSON.parse(raw) as {
      prompt?: string;
      meta?: Record<string, Record<string, unknown>>;
    };
    if (typeof ark.prompt === 'string' && ark.prompt.trim()) return ark.prompt.trim();
    const meta = ark.meta ? Object.values(ark.meta)[0] : undefined;
    if (meta) {
      const pick = (k: string): string => (typeof meta[k] === 'string' ? (meta[k] as string) : '');
      const t =
        pick('title') || pick('nickname') || pick('summary') || pick('desc') || pick('name');
      if (t) return t;
    }
    return '[卡片消息]';
  } catch {
    return '[卡片消息]';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function OverlayScrollbar({
  targetSelector,
  className,
  refreshKey,
}: {
  targetSelector: string;
  className: string;
  refreshKey: string;
}): ReactElement | null {
  const [state, setState] = useState<OverlayScrollbarState>(overlayScrollbarInitialState);
  const targetRef = useRef<HTMLElement | null>(null);
  const hoverRef = useRef(false);
  const draggingRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  const updateScrollbar = useCallback(() => {
    frameRef.current = null;

    const target = targetRef.current;
    if (!target) {
      setState(overlayScrollbarInitialState);
      return;
    }

    const rect = target.getBoundingClientRect();
    const maxScrollTop = target.scrollHeight - target.clientHeight;
    const canScroll = maxScrollTop > 1 && rect.height > 0 && rect.width > 0;
    if (!canScroll) {
      setState((current) => ({ ...current, visible: false, canScroll: false }));
      return;
    }

    const trackHeight = Math.max(0, rect.height - OVERLAY_SCROLLBAR_INSET * 2);
    const proportionalHeight = (target.clientHeight / target.scrollHeight) * trackHeight;
    const thumbHeight = clamp(proportionalHeight, OVERLAY_SCROLLBAR_MIN_THUMB, trackHeight);
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = OVERLAY_SCROLLBAR_INSET + (target.scrollTop / maxScrollTop) * maxThumbTop;

    setState({
      top: rect.top,
      left: rect.right - OVERLAY_SCROLLBAR_WIDTH - 2,
      height: rect.height,
      thumbTop,
      thumbHeight,
      visible: hoverRef.current || draggingRef.current,
      canScroll,
    });
  }, []);

  const scheduleUpdate = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(updateScrollbar);
  }, [updateScrollbar]);

  useEffect(() => {
    const target = document.querySelector<HTMLElement>(targetSelector);
    targetRef.current = target;
    hoverRef.current = false;
    draggingRef.current = false;

    if (!target) {
      setState(overlayScrollbarInitialState);
      return undefined;
    }

    function showScrollbar(): void {
      hoverRef.current = true;
      scheduleUpdate();
    }

    function hideScrollbar(): void {
      hoverRef.current = false;
      scheduleUpdate();
    }

    target.addEventListener('scroll', scheduleUpdate, { passive: true });
    target.addEventListener('mouseenter', showScrollbar);
    target.addEventListener('mouseleave', hideScrollbar);
    window.addEventListener('resize', scheduleUpdate);

    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(target);
    if (target.firstElementChild) resizeObserver.observe(target.firstElementChild);

    const mutationObserver = new MutationObserver(scheduleUpdate);
    mutationObserver.observe(target, { childList: true, subtree: true });

    scheduleUpdate();

    return () => {
      target.removeEventListener('scroll', scheduleUpdate);
      target.removeEventListener('mouseenter', showScrollbar);
      target.removeEventListener('mouseleave', hideScrollbar);
      window.removeEventListener('resize', scheduleUpdate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [refreshKey, scheduleUpdate, targetSelector]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const target = targetRef.current;
    if (!target) return;
    const scrollTarget = target;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    hoverRef.current = true;

    const startY = event.clientY;
    const startScrollTop = scrollTarget.scrollTop;
    const maxScrollTop = scrollTarget.scrollHeight - scrollTarget.clientHeight;
    const trackHeight = Math.max(
      0,
      scrollTarget.getBoundingClientRect().height - OVERLAY_SCROLLBAR_INSET * 2,
    );
    const maxThumbTravel = Math.max(1, trackHeight - state.thumbHeight);

    function handlePointerMove(moveEvent: PointerEvent): void {
      const delta = moveEvent.clientY - startY;
      scrollTarget.scrollTop = clamp(
        startScrollTop + (delta / maxThumbTravel) * maxScrollTop,
        0,
        maxScrollTop,
      );
      scheduleUpdate();
    }

    function handlePointerUp(): void {
      draggingRef.current = false;
      hoverRef.current = scrollTarget.matches(':hover');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      scheduleUpdate();
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    scheduleUpdate();
  }

  if (!state.canScroll) return null;

  return (
    <div
      className={`weq-custom-scrollbar ${className}${state.visible ? ' is-visible' : ''}`}
      style={{ top: state.top, left: state.left, height: state.height }}
    >
      <div
        className="weq-custom-scrollbar-thumb"
        onPointerDown={handlePointerDown}
        style={{ height: state.thumbHeight, transform: `translateY(${state.thumbTop}px)` }}
      />
    </div>
  );
}

function isMobileShell(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches;
}

export function MainView(): ReactElement {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);
  const contacts = trpc.account.listRecentContacts.useQuery();
  const topContacts = trpc.account.listTopContacts.useQuery();
  const hiddenSessions = trpc.account.listHiddenSessions.useQuery();
  const deletedSessions = trpc.account.listDeletedSessions.useQuery();
  const officialAccounts = trpc.account.listOfficialAccounts.useQuery();
  const serviceAccounts = trpc.account.listServiceAccounts.useQuery();
  const selfProfile = trpc.account.getSelfProfile.useQuery();
  const buddies = trpc.account.listBuddies.useQuery({ limit: 2000 });
  const botUidList = trpc.account.botUids.useQuery();
  const categories = trpc.account.listCategories.useQuery();
  const profiles = trpc.account.listProfiles.useQuery({ limit: 2000 });
  const buddyRequests = trpc.account.listBuddyRequests.useQuery({ limit: 2000 });
  const groupNotifies = trpc.account.listGroupNotifies.useQuery({ limit: 2000 });
  const allGroups = trpc.account.listAllGroups.useQuery({ limit: 2000 });
  const openedUin = useViewState((s) => s.openedUin);

  const goTo = useViewState((s) => s.goTo);
  const setHomeStage = useViewState((s) => s.setHomeStage);
  const setOpenedUin = useViewState((s) => s.setOpenedUin);

  // 合并会话面板状态：包含类型和点击位置
  const [mergedPanel, setMergedPanel] = useState<{
    kind: import('../im-template/template').MergedKind;
    anchorX: number;
    anchorY: number;
  } | null>(null);

  // ARK Feed 显示状态（公众号/服务号消息流）
  const [arkFeedState, setArkFeedState] = useState<{
    kind: 'official' | 'service';
    conversationId: string;
    title: string;
  } | null>(null);

  // Seq-window message model: a single ASC (oldest→newest) list for the open
  // conversation, plus whether it still reaches the latest message and whether
  // older history remains. `loaded[0].msgSeq` is the window's lower cursor.
  const [loaded, setLoaded] = useState<MessageWire[]>([]);
  const [anchoredToLatest, setAnchoredToLatest] = useState(true);

  // Latest active-conversation identity, read by the once-mounted live
  // subscription (which must not re-subscribe on every selection change).
  const selectionRef = useRef<{ id: string; kind: 'direct' | 'group' } | null>(null);
  // Current loaded-window descriptor, read by the once-mounted subscription.
  const windowRef = useRef<{ minSeq: string | null; anchored: boolean }>({
    minSeq: null,
    anchored: true,
  });

  // Live refresh of the open conversation: re-read seq >= minSeq and replace the
  // window. Only when anchored to latest — a history/search window (not yet
  // wired) must NOT be dragged up to the latest. Stable identity → the
  // subscription below mounts once.
  const refreshWindow = useCallback(async (): Promise<void> => {
    const sel = selectionRef.current;
    const win = windowRef.current;
    if (!sel || !win.anchored || win.minSeq === null) return;
    const kind = sel.kind === 'group' ? 'group' : 'c2c';
    const conv = sel.id;
    try {
      const page = await client.account.listFrom.query({
        kind,
        conv,
        sinceSeq: win.minSeq,
        limit: REFRESH_CAP,
      });
      if (selectionRef.current?.id !== conv) return; // switched away mid-flight
      setLoaded(page.map(toMessageWire).reverse());
    } catch (err) {
      console.error('[live] refreshWindow failed', err);
    }
  }, []);

  // Subscribe once to the debounced "db changed" ping: refresh recent contacts
  // and re-read the open conversation's window. (onNewMessages stays a backend
  // signal reserved for future popups; the open view no longer needs it.)
  useEffect(() => {
    const sub = client.account.onDbChanged.subscribe(undefined, {
      onData() {
        void utils.account.listRecentContacts.invalidate();
        void utils.account.listTopContacts.invalidate();
        void utils.account.listHiddenSessions.invalidate();
        void utils.account.listOfficialAccounts.invalidate();
        void utils.account.listServiceAccounts.invalidate();
        void refreshWindow();
      },
      onError(err) {
        console.error('[live] onDbChanged subscription error', err);
      },
    });
    return () => sub.unsubscribe();
  }, [utils, refreshWindow]);

  useEffect(() => {
    const sub = client.bootstrap.onAccountForcedClosed.subscribe(undefined, {
      onData(event) {
        // Defensive: only react to a real database-damaged event.
        if (event?.reason !== 'database-damaged') return;
        const accountKey = getQueryKey(trpc.account);
        void queryClient.cancelQueries({ queryKey: accountKey });
        queryClient.removeQueries({ queryKey: accountKey });
        setOpenedUin(null);
        setHomeStage('home');
        goTo('bootstrap');
        showError(
          event.title,
          <DatabaseDamagedDialogBody message={event.message} details={event.details} />,
        );
      },
      onError(err) {
        console.error('[account] onAccountForcedClosed subscription error', err);
      },
    });
    return () => sub.unsubscribe();
  }, [goTo, queryClient, setHomeStage, setOpenedUin, showError]);

  // Update availability: seed from the last cached check (the background startup
  // check may have already run), then keep it live via the check events. Drives
  // the settings rail red dot. setState via getState() to avoid re-render churn.
  useEffect(() => {
    const setAvailable = useUpdateStore.getState().setAvailable;
    void client.update.getState
      .query()
      .then((s) => {
        if (s?.hasUpdate && s.latest) setAvailable(s.latest);
      })
      .catch(() => {});
    const sub = client.update.onEvent.subscribe(undefined, {
      onData(e) {
        if ((e.kind === 'available' || e.kind === 'downloaded') && e.latest) {
          setAvailable(e.latest);
        }
      },
      onError(err) {
        console.error('[update] onEvent subscription error', err);
      },
    });
    return () => sub.unsubscribe();
  }, []);

  const [hasOlder, setHasOlder] = useState(true);
  // True only in a "jump context" window (anchored=false) that has newer
  // messages below it; drives scroll-down paging via `requestNewerMessages`.
  const [hasNewer, setHasNewer] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [trackedConversationId, setTrackedConversationId] = useState<string | null>(null);
  const [conversationPrefs, setConversationPrefs] = useState<ConversationPreferences>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [marketBrowserOpen, setMarketBrowserOpen] = useState(false);
  const [dressUpOpen, setDressUpOpen] = useState(false);
  // 装扮样式注入提到这一层 —— 进主界面就生效,不必先打开装扮灯箱。
  useDressSkin();
  const [albumDialog, setAlbumDialog] = useState<{
    groupCode: string;
    groupName: string;
  } | null>(null);
  const [groupFileDialog, setGroupFileDialog] = useState<{
    groupCode: string;
    groupName: string;
  } | null>(null);
  const [analyticsDialog, setAnalyticsDialog] = useState<{
    groupCode: string;
    groupName: string;
  } | null>(null);
  const [buddyAnalyticsDialog, setBuddyAnalyticsDialog] = useState<{
    peerUid: string;
    peerName: string;
  } | null>(null);
  const [announcementsDialog, setAnnouncementsDialog] = useState<{
    groupCode: string;
    groupName: string;
  } | null>(null);
  const [essenceDialog, setEssenceDialog] = useState<{
    groupCode: string;
    groupName: string;
  } | null>(null);
  const [memberCard, setMemberCard] = useState<{
    member: User;
    anchor: { x: number; y: number };
  } | null>(null);

  const [editorState, setEditorState] = useState<{
    msgId: string;
    elements: RawElementWire;
  } | null>(null);
  const [addMessageConv, setAddMessageConv] = useState<Conversation | null>(null);
  // "删除列表" panel: which conversation is open + its fetched deleted rows.
  const [deletedConv, setDeletedConv] = useState<Conversation | null>(null);
  const [deletedWires, setDeletedWires] = useState<MessageWire[]>([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  // "撤回列表" panel: which conversation is open + its fetched recalled rows.
  // Unlike deletes there's no restore — the anti-recall trigger already kept the
  // original message; this panel just lists what was recalled + by whom.
  const [recalledConv, setRecalledConv] = useState<Conversation | null>(null);
  const [recalledWires, setRecalledWires] = useState<MessageWire[]>([]);
  const [recalledLoading, setRecalledLoading] = useState(false);
  // msgIds WeQ deleted in the SELECTED conversation — drives the in-place
  // translucent overlay in the chat. Loaded per conversation, updated
  // optimistically on delete/restore.
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  const handleEditRaw = useCallback(async (message: Message) => {
    try {
      const result = await client.account.getRawElements.query({ msgId: message.id });
      if (result) {
        setEditorState({ msgId: message.id, elements: result.elements });
      }
    } catch (e) {
      console.error('[MainView] Failed to fetch raw elements:', e);
    }
  }, []);

  const handleSaveRaw = useCallback(
    async (elements: RawElementWire) => {
      if (!editorState) return;
      try {
        const success = await client.account.updateElements.mutate({
          msgId: editorState.msgId,
          elements,
        });
        if (success) {
          void refreshWindow();
        }
      } catch (e) {
        console.error('[MainView] Failed to update elements:', e);
        throw e;
      }
    },
    [editorState, refreshWindow],
  );

  /** kind + conversation key (peer uid / group code) used by the msg endpoints. */
  const convFetchKey = useCallback((c: Conversation): { kind: 'c2c' | 'group'; conv: string } => {
    if (c.type === 'group') return { kind: 'group', conv: c.group.identityValue };
    if (c.type === 'direct') return { kind: 'c2c', conv: c.otherUser.id };
    return { kind: 'c2c', conv: c.id }; // merged — should never actually be called
  }, []);

  // QQ-style delete: rewrites 40011/40012 to (1,1) in the DB — the message
  // stays in the chat under a translucent overlay. Optimistically mark it
  // deleted so the overlay appears instantly.
  const handleDeleteMessage = useCallback(
    async (message: Message, conversation: Conversation) => {
      const { kind, conv } = convFetchKey(conversation);
      setDeletedIds((current) => new Set(current).add(message.id));
      try {
        await client.account.deleteMessage.mutate({ msgId: message.id, kind, conv });
      } catch (e) {
        console.error('[MainView] Failed to delete message:', e);
        // Roll the optimistic overlay back on failure.
        setDeletedIds((current) => {
          const next = new Set(current);
          next.delete(message.id);
          return next;
        });
      }
    },
    [convFetchKey],
  );

  const handleOpenGroupAlbums = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>) => {
      setAlbumDialog({
        groupCode: conversation.id,
        groupName: conversation.group.name,
      });
    },
    [],
  );

  const handleOpenGroupFiles = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>) => {
      setGroupFileDialog({
        groupCode: conversation.id,
        groupName: conversation.group.name,
      });
    },
    [],
  );

  const handleOpenGroupAnnouncements = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>) => {
      setAnnouncementsDialog({
        groupCode: conversation.id,
        groupName: conversation.group.name,
      });
    },
    [],
  );

  const handleOpenGroupEssence = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>) => {
      setEssenceDialog({
        groupCode: conversation.id,
        groupName: conversation.group.name,
      });
    },
    [],
  );

  const handleOpenGroupAnalytics = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>) => {
      setAnalyticsDialog({
        groupCode: conversation.id,
        groupName: conversation.group.name,
      });
    },
    [],
  );

  const handleAddMessage = useCallback((conversation: Conversation) => {
    setAddMessageConv(conversation);
  }, []);

  const loadDeletedMessages = useCallback(
    async (c: Conversation): Promise<void> => {
      const { kind, conv } = convFetchKey(c);
      setDeletedLoading(true);
      try {
        const rows = await client.account.deletedMessages.query({ kind, conv });
        setDeletedWires(rows.map(toMessageWire));
      } catch (e) {
        console.error('[MainView] Failed to load deleted messages:', e);
        setDeletedWires([]);
      } finally {
        setDeletedLoading(false);
      }
    },
    [convFetchKey],
  );

  const handleViewDeleted = useCallback(
    (conversation: Conversation) => {
      setDeletedWires([]);
      setDeletedConv(conversation);
      void loadDeletedMessages(conversation);
    },
    [loadDeletedMessages],
  );

  const loadRecalledMessages = useCallback(
    async (c: Conversation): Promise<void> => {
      const { kind, conv } = convFetchKey(c);
      setRecalledLoading(true);
      try {
        const rows = await client.account.recalledMessages.query({ kind, conv });
        setRecalledWires(rows.map(toMessageWire));
      } catch (e) {
        console.error('[MainView] Failed to load recalled messages:', e);
        setRecalledWires([]);
      } finally {
        setRecalledLoading(false);
      }
    },
    [convFetchKey],
  );

  const handleViewRecalled = useCallback(
    (conversation: Conversation) => {
      setRecalledWires([]);
      setRecalledConv(conversation);
      void loadRecalledMessages(conversation);
    },
    [loadRecalledMessages],
  );

  const handleRestoreMessage = useCallback(
    async (msgId: string): Promise<void> => {
      await client.account.restoreMessage.mutate({ msgId });
      // Clear the in-place overlay for the restored message.
      setDeletedIds((current) => {
        const next = new Set(current);
        next.delete(msgId);
        return next;
      });
      if (deletedConv) {
        await loadDeletedMessages(deletedConv);
      }
      void refreshWindow();
    },
    [deletedConv, loadDeletedMessages, refreshWindow],
  );

  const handleOpenGroupMember = useCallback((member: User, anchor: { x: number; y: number }) => {
    setMemberCard({ member, anchor });
  }, []);

  const handleOpenBuddyAnalytics = useCallback(
    (conversation: Extract<Conversation, { type: 'direct' }>) => {
      setBuddyAnalyticsDialog({
        peerUid: conversation.otherUser.id,
        peerName:
          conversation.otherUser.displayName ||
          conversation.otherUser.username ||
          conversation.otherUser.identityValue ||
          'TA',
      });
    },
    [],
  );

  const [onlineStatusByUid, setOnlineStatusByUid] = useState<Record<string, OnlineStatusWire>>({});
  // Unread count per conversation id (latest msgSeq - last read seq). Filled
  // asynchronously after the recent-contact list loads / refreshes.
  const [unreadByConv, setUnreadByConv] = useState<Record<string, number>>({});
  const [highlightsByConv, setHighlightsByConv] = useState<Record<string, ConversationHighlight[]>>(
    {},
  );
  const [groupMemberPages, setGroupMemberPages] = useState<Record<string, GroupMemberWire[]>>({});
  const [groupMemberHasMore, setGroupMemberHasMore] = useState<Record<string, boolean>>({});
  const [groupMemberLoading, setGroupMemberLoading] = useState<Record<string, boolean>>({});
  const [groupMemberError, setGroupMemberError] = useState<Record<string, string>>({});
  const groupMemberLoadingRef = useRef<Record<string, boolean>>({});
  // Off-page message senders resolved on demand (groupCode → uid → member),
  // batched + deduped by useGroupMemberResolver. Kept separate from the global
  // profile cache because a group card is a (group × uid) thing, not a profile.
  const { missingMembers, resolveMembers } = useGroupMemberResolver<GroupMemberWire>();
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);

  // Unified sidebar search (sidebar search box → multi-category dropdown).
  // Fast categories (conversations / friends / group members) land first, then
  // the slow FTS categories (chat records / files) fill in their skeletons.
  const [searchQuick, setSearchQuick] = useState<QuickSearchResult | null>(null);
  const [searchQuickLoading, setSearchQuickLoading] = useState(false);
  const [searchSlow, setSearchSlow] = useState<SlowSearchResult | null>(null);
  const [searchSlowLoading, setSearchSlowLoading] = useState(false);
  // Temporary dismiss of the search dropdown — clicking outside it hides it
  // so the user can reach contact/group results underneath. Clicking the
  // search box or typing a new query restores the dropdown.
  const [searchDismissed, setSearchDismissed] = useState(false);
  // Set when a search hit was clicked: the listLatest effect, after the target
  // conversation's newest page lands, rebuilds the window centred on this seq
  // instead of leaving the view pinned to the latest.
  const pendingSearchJumpRef = useRef<{ conv: string; kind: 'group' | 'c2c'; seq: string } | null>(
    null,
  );
  // "更多" modal (full paginated results for one category) + chat-record modal.
  const [searchMore, setSearchMore] = useState<{
    category: SearchCategory;
    keyword: string;
  } | null>(null);
  const [chatRecordsTarget, setChatRecordsTarget] = useState<{
    hit: ChatRecordSearchHit;
    keyword: string;
  } | null>(null);

  // Mirror of `loaded` for the reply-jump handler (a stable callback that must
  // read the current window without being re-created on every message change).
  const loadedRef = useRef<MessageWire[]>([]);
  const pendingScrollRestoreRef = useRef<PendingScrollRestore | null>(null);

  const user = useMemo(
    () => currentUser(openedUin, selfProfile.data),
    [openedUin, selfProfile.data],
  );
  // 统一的 profile 内存缓存：listProfiles 预热 + 缺失项按需批量补全，所有消费方
  // （好友列表 / 通知 / 搜索）共用这一个 Map。补全在下方的解析 effect 触发。
  const { profileByUid, resolveProfiles } = useProfileResolver<UserProfileWire>(
    profiles.data as UserProfileWire[] | undefined,
  );
  const categoryById = useMemo(() => {
    return new Map(
      ((categories.data ?? []) as CategoryWire[]).map((category) => [category.id, category]),
    );
  }, [categories.data]);
  /** 机器人 uid 集合 —— 好友/群成员/会话/消息发送者都靠它打「机器人」标。 */
  const botUids = useMemo(() => new Set((botUidList.data ?? []) as string[]), [botUidList.data]);
  const buddyContacts = useMemo(
    () =>
      ((buddies.data ?? []) as BuddyWire[]).map((buddy) => {
        const contact = buddyToContact(buddy, profileByUid, categoryById, botUids);
        const statusObj = onlineStatusByUid[buddy.uid];
        return {
          ...contact,
          onlineStatus: statusObj?.displayStatus || contact.onlineStatus,
          onlineStatusObj: statusObj,
        };
      }),
    [buddies.data, categoryById, onlineStatusByUid, profileByUid, botUids],
  );
  // 置顶会话（recent_contact_top_table）：会话 id → 置顶时间（41103，秒）。
  const topTimeByConv = useMemo(() => {
    const map: Record<string, number> = {};
    for (const top of (topContacts.data ?? []) as RecentContactTopWire[]) {
      if (top.targetId) map[top.targetId] = Number(top.topTime);
    }
    return map;
  }, [topContacts.data]);
  // 群号 → 群名。隐藏会话面板（MergedSessionPanel）解析群聊显示名也要用它，
  // 提到 conversations useMemo 外面，避免闭包内重复构建两份。
  const groupNameByCode = useMemo(() => {
    const groups = (allGroups.data ?? []) as GroupDetailWire[];
    return new Map(groups.map((g) => [g.groupCode, g.groupName]));
  }, [allGroups.data]);
  // 隐藏会话 uid 集合：hidden_session_storage_table_v1 里有记录的 targetUid/群号。
  // 提到 conversations useMemo 外面，因为 hiddenConversationsById（供 shell 解析
  // 隐藏会话详情用）也要复用它。
  const hiddenUidSet = useMemo(() => {
    const list = (hiddenSessions.data ?? []) as HiddenSessionWire[];
    const set = new Set<string>();
    for (const hidden of list) {
      if (hidden.targetUid && hidden.resolvable) set.add(hidden.targetUid);
    }
    return set;
  }, [hiddenSessions.data]);

  // 删除会话 uid 集合：recent_contact_delete_storage 里有记录且不在 recent_contact 里的。
  const deletedUidSet = useMemo(() => {
    const list = (deletedSessions.data ?? []) as DeletedSessionWire[];
    const set = new Set<string>();
    for (const deleted of list) {
      if (deleted.targetUid && deleted.resolvable) set.add(deleted.targetUid);
    }
    return set;
  }, [deletedSessions.data]);

  // 隐藏会话不出现在主 conversations 列表里（见下方 useMemo），所以 shell 的
  // activeConversation 查找会失效——单独建一份供 selectedConversation 兜底解析，
  // 不然从隐藏会话选择器点进去后消息页面直接打不开。
  const hiddenConversationsById = useMemo(() => {
    const map = new Map<string, Conversation>();
    if (hiddenUidSet.size === 0) return map;
    for (const contact of (contacts.data ?? []) as RecentContactWire[]) {
      if (!hiddenUidSet.has(contact.targetUid)) continue;
      const conv = contactToConversation(contact, user, groupNameByCode, botUids);
      if (conv) map.set(conv.id, conv);
    }
    for (const detail of (allGroups.data ?? []) as GroupDetailWire[]) {
      if (!hiddenUidSet.has(detail.groupCode)) continue;
      map.set(detail.groupCode, groupDetailToConversation(detail, map.get(detail.groupCode), user));
    }
    return map;
  }, [hiddenUidSet, contacts.data, allGroups.data, groupNameByCode, user, botUids]);

  // 删除会话同样不在主列表（已从 recent_contact 消失），需要单独解析供点击后打开。
  // 和隐藏会话不同，删除会话已经不在 recent_contact 里，所以只能用 deletedSessions 数据。
  const deletedConversationsById = useMemo(() => {
    const map = new Map<string, Conversation>();
    if (deletedUidSet.size === 0) return map;

    for (const deleted of (deletedSessions.data ?? []) as DeletedSessionWire[]) {
      if (!deleted.resolvable || !deleted.targetUid) continue;

      const isGroup = deleted.chatType === 2;

      if (isGroup) {
        // 群聊：尝试从 allGroups 获取详细信息
        const groupDetail = (allGroups.data ?? []).find(
          (g: GroupDetailWire) => g.groupCode === deleted.targetUid,
        );
        if (groupDetail) {
          map.set(deleted.targetUid, groupDetailToConversation(groupDetail, undefined, user));
        } else {
          // 群详情不存在，构建最小会话对象
          const groupName = groupNameByCode.get(deleted.targetUid) || deleted.targetUid;
          map.set(deleted.targetUid, {
            id: deleted.targetUid,
            type: 'group',
            updatedAt: toIsoTime(deleted.sendTime),
            otherUser: null,
            group: {
              id: deleted.targetUid,
              name: groupName,
              identityLabel: 'Group',
              identityValue: deleted.targetUid,
              avatarUrl: groupAvatarSrc(deleted.targetUid),
              announcement: null,
              memberCount: 0,
              role: 'member',
            },
            members: [],
            preference: { pinned: false, muted: false, blocked: false },
            unreadCount: 0,
            lastMessage: null,
          });
        }
      } else {
        // 私聊：从 profiles 或 buddies 获取用户信息
        const profile = profileByUid.get(deleted.targetUid);
        const displayName = profile?.remark || profile?.nick || profile?.qid || deleted.targetUid;
        const avatarUrl = senderAvatarSrc(profile?.uin || '') || profile?.avatarUrl || null;

        map.set(deleted.targetUid, {
          id: deleted.targetUid,
          type: 'direct',
          updatedAt: toIsoTime(deleted.sendTime),
          otherUser: {
            id: deleted.targetUid,
            identityLabel: 'UID',
            identityValue: deleted.targetUid,
            username: deleted.targetUid,
            displayName,
            kind: 'human',
            avatarUrl,
          },
          group: null,
          members: [],
          preference: { pinned: false, muted: false, blocked: false },
          unreadCount: 0,
          lastMessage: null,
        });
      }
    }

    return map;
  }, [
    deletedUidSet,
    deletedSessions.data,
    allGroups.data,
    groupNameByCode,
    profileByUid,
    user,
    botUids,
  ]);
  const conversations = useMemo(() => {
    const groups = (allGroups.data ?? []) as GroupDetailWire[];
    const hiddenList = (hiddenSessions.data ?? []) as HiddenSessionWire[];
    const deletedList = (deletedSessions.data ?? []) as DeletedSessionWire[];

    // 只保留非 official/service 的 recent contacts（103/118 走合并会话入口）
    // 同时排除隐藏会话：hidden_session_storage_table_v1 里有的不出现在主列表
    const recentConversations = ((contacts.data ?? []) as RecentContactWire[])
      .filter((c) => {
        const kind = classifyChatType(c.chatType);
        if (kind === 'official' || kind === 'service') return false;
        // 隐藏会话：在 hidden_session_storage_table_v1 里有记录的，不出现在主列表
        if (hiddenUidSet.has(c.targetUid)) return false;
        return true;
      })
      .map((contact) => contactToConversation(contact, user, groupNameByCode, botUids))
      .filter((conversation): conversation is Conversation => conversation !== null);
    const byId = new Map(
      recentConversations.map((conversation) => [conversation.id, conversation]),
    );

    for (const detail of groups) {
      // 群也要检查：如果在 hidden_session_storage_table_v1 里，不加入主列表
      if (hiddenUidSet.has(detail.groupCode)) continue;
      byId.set(
        detail.groupCode,
        groupDetailToConversation(detail, byId.get(detail.groupCode), user),
      );
    }

    // 公众号合并会话：找所有 103 公众号里最新的那条 sendTime，合成一个 merged 入口。
    const officialList = (officialAccounts.data ?? []) as OfficialAccountWire[];
    if (officialList.length > 0) {
      const latest = officialList.reduce((a, b) =>
        Number(b.sendTime) > Number(a.sendTime) ? b : a,
      );
      const updatedAt = toIsoTime(latest.sendTime);
      const merged: import('../im-template/template').MergedConversation = {
        id: 'merged:official',
        type: 'merged',
        mergedKind: 'official',
        title: '公众号',
        avatarUrl: null,
        otherUser: null,
        group: null,
        members: [],
        updatedAt,
        preference: fallbackPreference,
        unreadCount: 0,
        lastMessage: {
          id: `merged:official:${latest.sendTime}`,
          senderId: null,
          body: latest.prompt,
          createdAt: updatedAt,
        },
      };
      byId.set('merged:official', merged);
    }

    // 服务号合并会话：同理取最新的那条。
    const serviceList = (serviceAccounts.data ?? []) as ServiceAccountWire[];
    if (serviceList.length > 0) {
      const latest = serviceList.reduce((a, b) =>
        Number(b.sendTime) > Number(a.sendTime) ? b : a,
      );
      const updatedAt = toIsoTime(latest.sendTime);
      const merged: import('../im-template/template').MergedConversation = {
        id: 'merged:service',
        type: 'merged',
        mergedKind: 'service',
        title: '服务号',
        avatarUrl: null,
        otherUser: null,
        group: null,
        members: [],
        updatedAt,
        preference: fallbackPreference,
        unreadCount: 0,
        lastMessage: {
          id: `merged:service:${latest.sendTime}`,
          senderId: null,
          body: latest.prompt,
          createdAt: updatedAt,
        },
      };
      byId.set('merged:service', merged);
    }

    // 隐藏会话合并入口：至少有一个隐藏会话时，置顶显示（不展示内部预览）。
    // 「两表都有才算隐藏会话」这条规则已经在后端 HiddenSessionService 里用不
    // 受分页限制的精确查询判断过了（resolvable 已经蕴含这个条件），这里不用
    // 再拿前端这份被 listRecentContacts 截断到 200 条的列表二次校验——用它反
    // 而会把真正命中、只是排在 200 名开外的隐藏会话又误杀掉。
    const validHiddenList = hiddenList.filter((h) => h.resolvable);

    if (validHiddenList.length > 0) {
      const latest = validHiddenList.reduce((a, b) =>
        Number(b.sendTime) > Number(a.sendTime) ? b : a,
      );
      const updatedAt = toIsoTime(latest.sendTime);
      const merged: import('../im-template/template').MergedConversation = {
        id: 'merged:hidden',
        type: 'merged',
        mergedKind: 'hidden',
        title: '隐藏会话',
        avatarUrl: null,
        otherUser: null,
        group: null,
        members: [],
        updatedAt,
        preference: { ...fallbackPreference, pinned: true },
        unreadCount: 0,
        lastMessage: {
          id: `merged:hidden:${latest.sendTime}`,
          senderId: null,
          body: null,
          createdAt: updatedAt,
        },
      };
      byId.set('merged:hidden', merged);
    }

    // 删除会话合并入口：至少有一个删除会话时，置顶显示（不展示内部预览）。
    // 删除会话已经从 recent_contact_v3_table 消失，后端已过滤掉"复活"的会话。
    const validDeletedList = deletedList.filter((d) => d.resolvable);

    if (validDeletedList.length > 0) {
      const latest = validDeletedList.reduce((a, b) =>
        Number(b.sendTime) > Number(a.sendTime) ? b : a,
      );
      const updatedAt = toIsoTime(latest.sendTime);
      const merged: import('../im-template/template').MergedConversation = {
        id: 'merged:deleted',
        type: 'merged',
        mergedKind: 'deleted',
        title: '最近删除',
        avatarUrl: null,
        otherUser: null,
        group: null,
        members: [],
        updatedAt,
        preference: { ...fallbackPreference, pinned: true },
        unreadCount: 0,
        lastMessage: {
          id: `merged:deleted:${latest.sendTime}`,
          senderId: null,
          body: null,
          createdAt: updatedAt,
        },
      };
      byId.set('merged:deleted', merged);
    }

    return (
      Array.from(byId.values())
        .map((conversation) => {
          const unread = unreadByConv[conversation.id];
          const highlights = highlightsByConv[conversation.id] ?? null;
          const topTime = topTimeByConv[conversation.id];
          if (!unread && !highlights && topTime === undefined) return conversation;
          return {
            ...conversation,
            ...(unread ? { unreadCount: unread } : {}),
            ...(topTime === undefined
              ? {}
              : {
                  preference: { ...fallbackPreference, ...conversation.preference, pinned: true },
                }),
            highlights,
          };
        })
        // 置顶会话整体排在最前，组内按置顶时间（41103）倒序；其余按最后消息时间倒序。
        .sort((a, b) => {
          const aTop = topTimeByConv[a.id];
          const bTop = topTimeByConv[b.id];
          if (aTop !== undefined || bTop !== undefined) {
            if (aTop === undefined) return 1;
            if (bTop === undefined) return -1;
            return bTop - aTop;
          }
          return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        })
    );
  }, [
    allGroups.data,
    contacts.data,
    officialAccounts.data,
    serviceAccounts.data,
    hiddenSessions.data,
    deletedSessions.data,
    hiddenUidSet,
    groupNameByCode,
    profileByUid,
    user,
    unreadByConv,
    highlightsByConv,
    topTimeByConv,
    botUids,
  ]);
  const groupsById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations],
  );
  const contactRequests = useMemo(
    () =>
      ((buddyRequests.data ?? []) as BuddyRequestWire[]).map((request) =>
        buddyRequestToContactRequest(request, profileByUid),
      ),
    [buddyRequests.data, profileByUid],
  );
  const groupRequests = useMemo(
    () =>
      ((groupNotifies.data ?? []) as GroupNotifyWire[])
        .filter((n) => [1, 3, 6, 11, 13, 15].includes(n.status))
        .map((n) => groupNotifyToGroupRequest(n, profileByUid, groupsById))
        .filter((r): r is NonNullable<typeof r> => r !== null),
    [groupNotifies.data, profileByUid, groupsById],
  );
  const shellHistory = useMemo(
    () => ({
      isMobileShell,
      // 从其它页（联系人/导出/助手…）切回「消息」时，落在 QQ 式企鹅占位而不是自动选中
      // 最近一条会话——会话由用户在左栏显式点选后才进入。
      shouldAutoSelectConversation: () => false,
      replaceShell: () => undefined,
      pushShellDetail: () => undefined,
      pushConversationDetail: () => undefined,
    }),
    [],
  );
  const shell = useChatShellController({
    conversations,
    contacts: buddyContacts,
    conversationPrefs,
    initialActiveConversationId: null,
    // 进入应用先落在主页（标题栏 logo 那颗按钮），会话由用户显式点选后才进入。
    initialView: 'home',
    sidebarWidthStorageKey: 'weq.desktop.sidebarWidth.v2',
    history: shellHistory,
  });

  // shell.activeConversation 只在主 conversations 列表里查找；隐藏会话和删除会话
  // 故意不进那份列表（见上方 conversations useMemo），所以查不到时兜底查
  // hiddenConversationsById 和 deletedConversationsById —— 否则从选择器点进去，消息页面直接打不开。
  const selectedConversation =
    shell.activeConversation ??
    (shell.activeConversationId
      ? hiddenConversationsById.get(shell.activeConversationId)
      : undefined) ??
    (shell.activeConversationId
      ? deletedConversationsById.get(shell.activeConversationId)
      : undefined);
  const selectedUid = selectedConversation?.id ?? '';
  const isGroup = selectedConversation?.type === 'group';
  const isDirect = selectedConversation?.type === 'direct';

  const handleSelectConversation = useCallback(
    (conversationId: string, event?: React.MouseEvent) => {
      const conv = conversations.find((c) => c.id === conversationId);
      if (conv?.type === 'merged') {
        // 只是打开会话选择器面板，当前页面（包括正在看的 ARK Feed）先保持不动——
        // 之前在这里无条件 setArkFeedState(null) 会导致点选择器就直接退出消息页。
        const x = event?.clientX ?? window.innerWidth / 2;
        const y = event?.clientY ?? window.innerHeight / 2;
        setMergedPanel({ kind: conv.mergedKind, anchorX: x, anchorY: y });
        return;
      }
      // 真正切换到一个普通会话时才关闭 ARK Feed。
      setArkFeedState(null);
      shell.selectConversation(conversationId);
    },
    [conversations, shell],
  );

  // Load the WeQ-deleted msgIds whenever the selected conversation changes so
  // the in-place "deleted" overlay is correct on entry. Stale responses from a
  // quickly-switched-away conversation are ignored.
  useEffect(() => {
    setDeletedIds(new Set());
    if (!selectedConversation) return;
    const { kind, conv } = convFetchKey(selectedConversation);
    let alive = true;
    client.account.deletedMsgIds
      .query({ kind, conv })
      .then((ids) => {
        if (alive) setDeletedIds(new Set(ids));
      })
      .catch(() => {
        /* overlay silently absent on failure; delete/restore still work */
      });
    return () => {
      alive = false;
    };
  }, [selectedConversation, convFetchKey]);

  // 群资料灯箱：拉取所选群在 group_member3 里的前若干名成员，用于头像横排展示。
  const groupDetailCode = shell.selectedGroupConversationId ?? '';
  const groupDetailMembers = trpc.account.listGroupMembers.useQuery(
    { groupCode: groupDetailCode, limit: 14, offset: 0 },
    { enabled: Boolean(groupDetailCode) },
  );
  const selectedGroupConversationForDetail = useMemo(() => {
    const conv = shell.selectedGroupConversation;
    if (!conv) return conv;
    const members = ((groupDetailMembers.data ?? []) as GroupMemberWire[]).map((m) => ({
      id: m.uid,
      identityLabel: m.uin && m.uin !== '0' ? 'QQ' : 'UID',
      identityValue: m.uin && m.uin !== '0' ? m.uin : m.uid,
      username: m.uid,
      displayName: m.card || m.nick || m.uin || 'Member',
      avatarUrl: senderAvatarSrc(m.uin),
      kind: botUids.has(m.uid) ? ('bot' as const) : ('human' as const),
      role: 'member' as const,
      joinedAt: new Date(0).toISOString(),
    }));
    return { ...conv, members };
  }, [shell.selectedGroupConversation, groupDetailMembers.data, botUids]);

  // 切换到独占全屏的视图（home/export/agentlab/cache/qzone/channel）时，
  // 自动关闭可能还开着的公众号/服务号 ARK Feed 页面，否则会覆盖在新视图上。
  useEffect(() => {
    const fullBleed =
      shell.view === 'home' ||
      shell.view === 'export' ||
      shell.view === 'agentlab' ||
      shell.view === 'cache' ||
      shell.view === 'qzone' ||
      shell.view === 'channel';
    if (fullBleed && arkFeedState) {
      setArkFeedState(null);
    }
  }, [shell.view, arkFeedState]);

  useEffect(() => {
    const buddyList = ((buddies.data ?? []) as BuddyWire[]).slice(0, 300);
    if (buddyList.length === 0) return undefined;
    let cancelled = false;

    async function loadOnlineStatuses(): Promise<void> {
      const next: Record<string, OnlineStatusWire> = {};
      const batchSize = 12;
      for (let index = 0; index < buddyList.length && !cancelled; index += batchSize) {
        const batch = buddyList.slice(index, index + batchSize);
        const statuses = await Promise.all(
          batch.map(async (buddy) => {
            try {
              const status = await client.account.getOnlineStatus.query({ uid: buddy.uid });
              return status ? ([buddy.uid, status] as const) : null;
            } catch {
              return null;
            }
          }),
        );
        for (const status of statuses) {
          if (status) next[status[0]] = status[1];
        }
        if (!cancelled && Object.keys(next).length > 0) {
          setOnlineStatusByUid((current) => ({ ...current, ...next }));
        }
      }
    }

    void loadOnlineStatuses();
    return () => {
      cancelled = true;
    };
  }, [buddies.data]);

  // Compute unread counts: for each recent conversation, query the last-read
  // seq and subtract from the latest msgSeq. Re-runs whenever the contact list
  // updates (every db change invalidates listRecentContacts). chatType: 1=c2c,
  // 2=group — matching the "chatType_uid" key in msg_unread_info_table.
  useEffect(() => {
    const list = (contacts.data ?? []) as RecentContactWire[];
    if (list.length === 0) return undefined;
    let cancelled = false;

    async function loadUnread(): Promise<void> {
      const next: Record<string, number> = {};
      const highlights: Record<string, ConversationHighlight[]> = {};
      const batchSize = 12;
      for (let index = 0; index < list.length && !cancelled; index += batchSize) {
        const batch = list.slice(index, index + batchSize);
        const counts = await Promise.all(
          batch.map(async (contact) => {
            const kind = chatTypeKind(contact.chatType);
            if (kind === null) return null;
            const chatType = kind === 'group' ? 2 : 1;
            try {
              const info = await client.account.getUnreadInfo.query({
                chatType,
                uid: contact.targetUid,
              });
              const latest = BigInt(contact.msgSeq || '0');
              const read = info?.msgSeq ? BigInt(info.msgSeq) : 0n;
              const unread = latest > read ? Number(latest - read) : 0;
              return {
                uid: contact.targetUid,
                unread,
                highlights: (info?.highlights ?? null) as ConversationHighlight[] | null,
              };
            } catch {
              return null;
            }
          }),
        );
        for (const entry of counts) {
          if (!entry) continue;
          next[entry.uid] = entry.unread;
          if (entry.highlights?.length) highlights[entry.uid] = entry.highlights;
        }
      }
      if (!cancelled) {
        setUnreadByConv(next);
        setHighlightsByConv(highlights);
      }
    }

    void loadUnread();
    return () => {
      cancelled = true;
    };
  }, [contacts.data]);

  // Reset paging *synchronously* when the open conversation changes. Doing this
  // during render (instead of in an effect) means React discards this render
  // before committing, so we never paint a frame where the previous chat's
  // messages are shown under the new conversation, nor flash an empty
  // "还没有消息" before the new query result is folded in.
  if (trackedConversationId !== shell.activeConversationId) {
    setTrackedConversationId(shell.activeConversationId);
    setLoaded([]);
    setAnchoredToLatest(true);
    setHasOlder(true);
    setHasNewer(false);
    setMessagesLoading(Boolean(shell.activeConversationId));
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    pendingScrollRestoreRef.current = null;
  }

  const groupDetail = trpc.account.getGroupDetail.useQuery(
    { groupCode: selectedUid },
    { enabled: Boolean(selectedUid && isGroup) },
  );
  const groupBulletins = trpc.account.listGroupBulletins.useQuery(
    { groupCode: selectedUid, limit: 10, offset: 0 },
    { enabled: Boolean(selectedUid && isGroup) },
  );
  const groupEssence = trpc.account.listGroupEssenceMessages.useQuery(
    { groupCode: selectedUid, limit: 10, offset: 0 },
    { enabled: Boolean(selectedUid && isGroup) },
  );
  // 尝试从 Web API 获取带消息内容的精华消息（需要在线账号/有效 cookie）
  const groupEssenceWeb = trpc.account.getGroupEssenceWithContent.useQuery(
    { groupCode: selectedUid, pageStart: 0, pageLimit: 50 },
    { enabled: Boolean(selectedUid && isGroup), retry: false, staleTime: 5 * 60 * 1000 },
  );
  const groupLevelInfo = trpc.account.getGroupMemberLevelInfo.useQuery(
    { groupCode: selectedUid },
    { enabled: Boolean(selectedUid && isGroup) },
  );
  const groupExt = trpc.account.getGroupExt.useQuery(
    { groupCode: selectedUid },
    { enabled: Boolean(selectedUid && isGroup) },
  );
  const selectedGroupMemberWires = isGroup ? (groupMemberPages[selectedUid] ?? []) : [];
  const selectedGroupMembersLoading = Boolean(isGroup && groupMemberLoading[selectedUid]);
  const selectedGroupMembersHasMore = Boolean(isGroup && groupMemberHasMore[selectedUid]);
  const selectedGroupMembersError = isGroup ? (groupMemberError[selectedUid] ?? null) : null;

  const loadGroupMembersPage = useCallback(
    async (groupCode: string, offset: number): Promise<void> => {
      if (!groupCode) return;
      if (groupMemberLoadingRef.current[groupCode]) return;
      groupMemberLoadingRef.current = {
        ...groupMemberLoadingRef.current,
        [groupCode]: true,
      };
      setGroupMemberLoading((current) => {
        if (current[groupCode]) return current;
        return { ...current, [groupCode]: true };
      });

      try {
        const page = await client.account.listGroupMembers.query({
          groupCode,
          limit: GROUP_MEMBER_PAGE_SIZE,
          offset,
        });

        if (selectionRef.current?.id !== groupCode) {
          // User switched away during loading - cleanup and bail
          groupMemberLoadingRef.current = {
            ...groupMemberLoadingRef.current,
            [groupCode]: false,
          };
          setGroupMemberLoading((current) => ({ ...current, [groupCode]: false }));
          return;
        }

        setGroupMemberPages((current) => {
          const existing = offset === 0 ? [] : (current[groupCode] ?? []);
          const known = new Set(existing.map((member) => member.uid));
          const fresh = page.filter((member) => !known.has(member.uid));
          return { ...current, [groupCode]: [...existing, ...fresh] };
        });
        setGroupMemberHasMore((current) => ({
          ...current,
          [groupCode]: page.length >= GROUP_MEMBER_PAGE_SIZE,
        }));
        // 如果第一次查询就返回空，说明数据库里没有缓存
        if (offset === 0 && page.length === 0) {
          setGroupMemberError((current) => ({
            ...current,
            [groupCode]: '数据库中没有该群的成员信息',
          }));
        } else {
          setGroupMemberError((current) => ({ ...current, [groupCode]: '' }));
        }
      } catch (err) {
        console.error('[group-members] listGroupMembers failed', err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        setGroupMemberError((current) => ({ ...current, [groupCode]: errorMessage }));
        setGroupMemberHasMore((current) => ({ ...current, [groupCode]: false }));
      } finally {
        groupMemberLoadingRef.current = {
          ...groupMemberLoadingRef.current,
          [groupCode]: false,
        };
        setGroupMemberLoading((current) => ({ ...current, [groupCode]: false }));
      }
    },
    [],
  );

  const requestMoreGroupMembers = useCallback((): void => {
    if (!selectedUid || !isGroup || selectedGroupMembersLoading || selectedGroupMembersError)
      return;
    // 如果已经加载过但没有更多数据，不再重试（包括第一次查询返回空的情况）
    if (!selectedGroupMembersHasMore && selectedUid in groupMemberHasMore) return;
    void loadGroupMembersPage(selectedUid, selectedGroupMemberWires.length);
  }, [
    isGroup,
    loadGroupMembersPage,
    selectedGroupMemberWires.length,
    selectedGroupMembersHasMore,
    selectedGroupMembersLoading,
    selectedGroupMembersError,
    selectedUid,
    groupMemberHasMore,
  ]);

  useEffect(() => {
    if (!selectedUid || !isGroup) return;
    if (
      selectedGroupMemberWires.length > 0 ||
      selectedGroupMembersLoading ||
      selectedGroupMembersError
    )
      return;
    requestMoreGroupMembers();
  }, [
    isGroup,
    requestMoreGroupMembers,
    selectedGroupMemberWires.length,
    selectedGroupMembersLoading,
    selectedGroupMembersError,
    selectedUid,
  ]);

  // `loaded` is already oldest→newest; the template renders in array order.
  const loadedMessageWires = loaded;
  const currentGroupMembers = useMemo(() => {
    if (selectedConversation?.type !== 'group') return [];

    const detail = groupDetail.data;
    const levelConfigs = groupLevelInfo.data?.levelConfigs ?? [];

    const allMemberWires = [...selectedGroupMemberWires];
    // Merge in only THIS group's on-demand-resolved senders.
    const groupMissing = missingMembers[selectedUid] ?? {};
    Object.values(groupMissing).forEach((m) => {
      if (!allMemberWires.find((em) => em.uid === m.uid)) {
        allMemberWires.push(m);
      }
    });

    const mapped: GroupMember[] = allMemberWires.map((m) => ({
      id: m.uid,
      identityLabel: m.uin && m.uin !== '0' ? 'QQ' : 'UID',
      identityValue: m.uin && m.uin !== '0' ? m.uin : m.uid,
      username: m.uid,
      displayName: m.card || m.nick || m.uin || 'Member',
      avatarUrl: senderAvatarSrc(m.uin),
      kind: botUids.has(m.uid) ? 'bot' : 'human',
      role: m.uid === detail?.ownerUid ? 'owner' : m.adminFlag > 0 ? 'admin' : 'member',
      joinedAt: toIsoTime(m.joinTime.toString()),
      lastSpeakAt: secondsToIsoTime(m.lastSpeakTime),
      muteUntil: secondsToIsoTime(m.muteUntil),
      customTitle: m.customTitle || null,
      memberLevel: m.memberLevel,
      levelName: levelNameFor(levelConfigs, m.memberLevel),
    }));

    return mapped.sort((a, b) => {
      const roleScore = { owner: 0, admin: 1, member: 2 };
      return roleScore[a.role] - roleScore[b.role];
    });
  }, [
    selectedConversation,
    selectedUid,
    groupDetail.data,
    groupLevelInfo.data,
    selectedGroupMemberWires,
    missingMembers,
    botUids,
  ]);

  // Resolve message senders / gray-tip targets that fall outside the loaded
  // member page. Messages render immediately with the uin fallback; the real
  // card/nick is batched in by useGroupMemberResolver without blocking. Dedup
  // (known page + already-attempted) lives in the resolver, so this effect just
  // hands it every referenced uid.
  useEffect(() => {
    if (!selectedUid || !isGroup || loaded.length === 0) return;
    const groupCode = selectedUid;
    const known = new Set(selectedGroupMemberWires.map((m) => m.uid));
    const referencedUids = [
      ...loaded.map((m) => m.senderUid),
      // Gray-tip payloads reference members by uid inside their element bodies
      // (poke/invite XML, mute info) — resolve those too, not just senders.
      ...loaded.flatMap((m) => extractGrayTipUids(m.elements)),
    ];
    resolveMembers(groupCode, referencedUids, known, () => selectionRef.current?.id === groupCode);
  }, [loaded, selectedUid, isGroup, selectedGroupMemberWires, resolveMembers]);

  // Resolve display profiles for everyone we render a name/avatar for: buddies,
  // buddy requests, and the operated user in each group notify. resolveProfiles
  // dedupes against the primed set + in-flight requests, so handing it the whole
  // batch every render issues at most one query per never-seen uid.
  useEffect(() => {
    const uids: string[] = [];
    for (const buddy of (buddies.data ?? []) as BuddyWire[]) uids.push(buddy.uid);
    for (const request of (buddyRequests.data ?? []) as BuddyRequestWire[])
      uids.push(request.peerUid);
    for (const notify of (groupNotifies.data ?? []) as GroupNotifyWire[]) {
      if (![1, 3, 6, 11, 13, 15].includes(notify.status)) continue;
      if (notify.operatedUid) uids.push(notify.operatedUid);
      if (notify.operatorUid) uids.push(notify.operatorUid);
    }
    // 隐藏会话没有 QQ 预置的显示名列，靠 profile 缓存补昵称/头像（同 buddy 列表）。
    for (const hidden of (hiddenSessions.data ?? []) as HiddenSessionWire[]) {
      if (hidden.resolvable && chatTypeKind(hidden.chatType) === 'direct')
        uids.push(hidden.targetUid);
    }
    // 删除会话同样需要 profile 缓存补昵称/头像。
    for (const deleted of (deletedSessions.data ?? []) as DeletedSessionWire[]) {
      if (deleted.resolvable && (deleted.chatType === 1 || deleted.chatType === 10))
        uids.push(deleted.targetUid);
    }
    resolveProfiles(uids);
  }, [
    buddies.data,
    buddyRequests.data,
    groupNotifies.data,
    hiddenSessions.data,
    deletedSessions.data,
    resolveProfiles,
  ]);

  const templateMessages = useMemo(() => {
    if (!selectedConversation) return [];

    // Create a fast lookup map for member info
    const memberMap = new Map(currentGroupMembers.map((m) => [m.id, m]));

    return loadedMessageWires
      .filter((message) => isRenderableMessage(message))
      .map((message) => messageToTemplate(message, selectedConversation, user, memberMap, botUids));
  }, [loadedMessageWires, selectedConversation, user, currentGroupMembers, botUids]);

  // Deleted messages built through the SAME template pipeline as the live chat,
  // so the panel's bubbles match exactly. The panel only opens for the currently
  // selected conversation, so `currentGroupMembers` is the right member source.
  const deletedTemplateMessages = useMemo(() => {
    if (!deletedConv) return [];
    const memberMap = new Map(currentGroupMembers.map((m) => [m.id, m]));
    return deletedWires
      .filter((message) => isRenderableMessage(message))
      .map((message) => messageToTemplate(message, deletedConv, user, memberMap, botUids));
  }, [deletedWires, deletedConv, user, currentGroupMembers, botUids]);

  // Recalled messages through the SAME template pipeline (bubbles match the chat
  // + carry the 撤回 tag). Same member source as the deleted panel.
  const recalledTemplateMessages = useMemo(() => {
    if (!recalledConv) return [];
    const memberMap = new Map(currentGroupMembers.map((m) => [m.id, m]));
    return recalledWires
      .filter((message) => isRenderableMessage(message))
      .map((message) => messageToTemplate(message, recalledConv, user, memberMap, botUids));
  }, [recalledWires, recalledConv, user, currentGroupMembers, botUids]);

  const activeConversation = useMemo(() => {
    if (!selectedConversation) return undefined;
    if (selectedConversation.type !== 'group') return selectedConversation;
    const detail = groupDetail.data as GroupDetailWire | null | undefined;

    return {
      ...selectedConversation,
      members: currentGroupMembers,
      group: {
        ...selectedConversation.group!,
        name: detail?.groupName || selectedConversation.group!.name,
        memberCount: detail?.memberCount || selectedConversation.group!.memberCount,
        maxMemberCount: detail?.maxMemberCount || selectedConversation.group!.maxMemberCount,
        announcement: detail?.pinnedAnnounce || selectedConversation.group!.announcement || null,
        description: detail?.description || null,
        remark: detail?.remark || null,
        createTime: secondsToIsoTime(detail?.createTime),
        labels: detail?.labels || null,
        entranceQ: detail?.entranceQ || null,
        customLabels:
          detail?.customLabels
            ?.map((label) => label.content)
            .filter((label): label is string => Boolean(label)) ?? [],
        addressName: detail?.address?.locationName || null,
        bulletins: ((groupBulletins.data ?? []) as GroupBulletinWire[]).map((bulletin, index) => {
          // publisherUid 可能是 UID（数据库）或 UIN（Web API），尝试两者匹配
          const publisher = currentGroupMembers.find(
            (m) => m.id === bulletin.publisherUid || m.identityValue === bulletin.publisherUid,
          );
          return {
            id: bulletin.fid || `bulletin:${index}`,
            text: bulletin.textContent,
            createdAt:
              secondsToIsoTime(bulletin.ctime) ??
              secondsToIsoTime(bulletin.msgTime) ??
              new Date(0).toISOString(),
            publisherUid: bulletin.publisherUid,
            publisherName: publisher?.displayName,
            publisherAvatar: publisher?.avatarUrl,
          };
        }),
        essenceMessages: ((groupEssence.data ?? []) as GroupEssenceWire[]).map((item) => {
          // 尝试从 Web API 结果中找到匹配的消息内容（按 msgSeq 匹配）
          const webItem = (groupEssenceWeb.data ?? []).find(
            (web: GroupEssenceWire) => web.msgSeq === item.msgSeq,
          );
          return {
            id: `essence:${item.msgSeq}:${item.timestamp}`,
            msgSeq: item.msgSeq,
            senderName: item.senderNick,
            operatorName: item.operatorNick,
            createdAt: secondsToIsoTime(item.timestamp) ?? new Date(0).toISOString(),
            active: item.setStatus === 1,
            // 从 Web API 补充的字段
            content: webItem?.content,
            senderTime: webItem?.senderTime,
            canRemove: webItem?.canRemove,
          };
        }),
        levelConfigs: (groupLevelInfo.data?.levelConfigs ?? []).map((item) => ({
          level: item.level,
          name: item.levelName,
        })),
        role: currentGroupMembers.find((m) => m.id === user.id)?.role || 'member',
        luckyChar:
          groupExt.data?.luckyCharId && groupExt.data.luckyCharId !== 0
            ? { id: groupExt.data.luckyCharId, litCount: groupExt.data.luckyCharLitCount }
            : null,
      },
    };
  }, [
    selectedConversation,
    currentGroupMembers,
    groupBulletins.data,
    groupDetail.data,
    groupEssence.data,
    groupEssenceWeb.data,
    groupLevelInfo.data,
    groupExt.data,
    user,
  ]);
  // "loading" only until the first page lands; gating on this (not react-query)
  // keeps a switch-into from flashing "还没有消息" before the query resolves.
  const loadingInitialMessages =
    Boolean(selectedConversation) && messagesLoading && loaded.length === 0;

  useEffect(() => {
    if (contacts.isLoading) return;
    // Don't auto-open the first conversation: land on the empty placeholder and
    // let the user pick. Only clear a selection that no longer exists — hidden
    // sessions are deliberately absent from `conversations` (see hiddenConversationsById),
    // so they must be exempted here too or this immediately un-selects them right
    // after the hidden-session picker sets them. Same for deleted sessions.
    if (
      shell.activeConversationId &&
      !conversations.some((conversation) => conversation.id === shell.activeConversationId) &&
      !hiddenConversationsById.has(shell.activeConversationId) &&
      !deletedConversationsById.has(shell.activeConversationId)
    ) {
      shell.setActiveConversationId(null);
    }
  }, [
    contacts.isLoading,
    conversations,
    hiddenConversationsById,
    deletedConversationsById,
    shell.activeConversationId,
    shell.setActiveConversationId,
  ]);

  // Keep the live-subscription's view of "what's open" current without
  // re-subscribing on every selection change.
  useEffect(() => {
    selectionRef.current =
      selectedUid && (isDirect || isGroup)
        ? { id: selectedUid, kind: isGroup ? 'group' : 'direct' }
        : null;
  }, [selectedUid, isDirect, isGroup]);

  // Keep the loaded-window descriptor in sync for the once-mounted subscription.
  useEffect(() => {
    windowRef.current = { minSeq: loaded[0]?.msgSeq ?? null, anchored: anchoredToLatest };
    loadedRef.current = loaded;
  }, [loaded, anchoredToLatest]);

  // Scroll the loaded list to a message row by id and briefly flash it.
  const scrollToMsgId = useCallback((msgId: string): boolean => {
    const line = document.querySelector<HTMLElement>(
      `.weq-readonly-chat .message-scroll [data-message-id="${msgId}"]`,
    );
    if (!line) return false;
    line.scrollIntoView({ block: 'center' });
    line.classList.add('weq-reply-target-flash');
    window.setTimeout(() => line.classList.remove('weq-reply-target-flash'), 1600);
    return true;
  }, []);

  // Rebuild the loaded window centred on `targetSeq` straight from the DB,
  // discarding whatever is loaded now. Keeps long jumps (reply to an ancient
  // message, or search → jump years back) constant-cost instead of loading
  // everything between the latest and the target. Returns true if the target
  // was found and the view repositioned. `conv`/`kind` are passed explicitly so
  // it works right after a conversation switch (before selectionRef settles).
  const centerWindowOnSeq = useCallback(
    async (conv: string, kind: 'group' | 'c2c', targetSeq: string): Promise<boolean> => {
      let before: ChatMsgWire[];
      let after: ChatMsgWire[];
      try {
        [before, after] = await Promise.all([
          // `< target+1` is `<= target`, so the centre message is included.
          client.account.listBefore.query({
            kind,
            conv,
            beforeSeq: String(BigInt(targetSeq) + 1n),
            limit: PAGE_SIZE,
          }),
          client.account.listAfter.query({ kind, conv, afterSeq: targetSeq, limit: PAGE_SIZE }),
        ]);
      } catch (err) {
        console.error('[centerWindowOnSeq] fetch failed', err);
        pushToast({ tone: 'info', title: '未找到该消息' });
        return false;
      }
      if (selectionRef.current?.id !== conv) {
        return false; // switched away mid-flight
      }

      const seen = new Set<string>();
      const merged: MessageWire[] = [];
      // before is DESC (newest-first) incl. centre → reverse to ASC; after is ASC.
      for (const m of [...before.map(toMessageWire).reverse(), ...after.map(toMessageWire)]) {
        if (seen.has(m.msgId)) continue;
        seen.add(m.msgId);
        merged.push(m);
      }

      const target = merged.find((m) => m.msgSeq === targetSeq);
      if (!target) {
        pushToast({ tone: 'info', title: '未找到该消息' });
        return false; // not in DB (e.g. recalled) — leave the view as-is
      }

      const atLatest = after.length < PAGE_SIZE;
      // Update the live-subscription's window descriptor synchronously: a
      // db-changed tick between this setLoaded and the passive windowRef effect
      // must not see the stale (anchored, old-minSeq) descriptor and replace our
      // freshly-jumped window via refreshWindow's listFrom.
      windowRef.current = { minSeq: merged[0]?.msgSeq ?? null, anchored: atLatest };
      setLoaded(merged);
      setHasOlder(before.length >= PAGE_SIZE);
      setHasNewer(!atLatest);
      // If the centre sits near the tail, re-anchor so live messages flow in;
      // otherwise stay detached so refreshWindow won't drag us to the latest.
      setAnchoredToLatest(atLatest);
      window.setTimeout(() => scrollToMsgId(target.msgId), 160);
      return true;
    },
    [scrollToMsgId, pushToast],
  );

  // Scroll the loaded message list to a reply target, loading older pages first
  // if it isn't in the window yet, then briefly flash it. The 40003 anchor lives
  // in a different reply field per kind (verified against the live DB):
  //   group → origMsgSeq (47402);  c2c → origMsgIndex (47419).
  const jumpToSeq = useCallback(
    async (jumpTarget: ReplyJumpTarget): Promise<void> => {
      const sel = selectionRef.current;
      if (!sel) {
        return;
      }
      const kind: 'group' | 'c2c' = sel.kind === 'group' ? 'group' : 'c2c';
      const rawSeq =
        kind === 'group'
          ? (jumpTarget.seq ?? jumpTarget.index)
          : (jumpTarget.index ?? jumpTarget.seq);
      if (rawSeq === undefined || rawSeq === null || rawSeq === '') {
        pushToast({ tone: 'info', title: '未找到该消息' });
        return;
      }
      const targetSeq = String(rawSeq);

      const here = loadedRef.current.find((m) => m.msgSeq === targetSeq);
      if (here) {
        scrollToMsgId(here.msgId);
        return;
      }

      const targetNum = Number(targetSeq);

      // Slow path A: the target is just above the window — reach it by loading a
      // few scroll-up pages (cheap, preserves the current context). Capped at 3.
      let working = loadedRef.current.slice();
      let reachedTop = false;
      for (let guard = 0; guard < 3; guard += 1) {
        const minSeq = working[0]?.msgSeq;
        if (!minSeq || Number(minSeq) <= targetNum) {
          break;
        }
        if (working.some((m) => m.msgSeq === targetSeq)) {
          break;
        }
        let older: ChatMsgWire[];
        try {
          older = await client.account.listBefore.query({
            kind,
            conv: sel.id,
            beforeSeq: minSeq,
            limit: PAGE_SIZE,
          });
        } catch (err) {
          console.error('[jumpToSeq] listBefore failed', err);
          pushToast({ tone: 'info', title: '加载消息失败' });
          break;
        }
        if (selectionRef.current?.id !== sel.id) {
          return; // switched away mid-flight
        }
        const known = new Set(working.map((m) => m.msgId));
        const fresh = older
          .map(toMessageWire)
          .reverse()
          .filter((m) => !known.has(m.msgId));
        if (fresh.length === 0) {
          reachedTop = true;
          break;
        }
        working = [...fresh, ...working];
        if (older.length < PAGE_SIZE) {
          reachedTop = true;
          break;
        }
      }

      const target = working.find((m) => m.msgSeq === targetSeq);
      if (target) {
        setLoaded(working);
        if (reachedTop) setHasOlder(false);
        // Let the prepended rows paint (and any scroll-restore settle) before scrolling.
        window.setTimeout(() => scrollToMsgId(target.msgId), 160);
        return;
      }

      // Slow path B: still not found after 3 pages — rebuild a fresh window
      // centred on the target instead of loading everything up to it.
      await centerWindowOnSeq(sel.id, kind, targetSeq);
    },
    [centerWindowOnSeq, scrollToMsgId, pushToast],
  );

  // Debounced unified search: fast categories (conversation/friend/groupMember)
  // land first, then the slow FTS categories (chat records/files). A run counter
  // discards stale responses so only the last keystroke's results win.
  const searchQuery = shell.query.trim();
  const searchRunRef = useRef(0);
  useEffect(() => {
    if (shell.view !== 'messages' && shell.view !== 'contacts') {
      setSearchQuick(null);
      setSearchSlow(null);
      setSearchQuickLoading(false);
      setSearchSlowLoading(false);
      return undefined;
    }
    if (!searchQuery) {
      setSearchQuick(null);
      setSearchSlow(null);
      setSearchQuickLoading(false);
      setSearchSlowLoading(false);
      return undefined;
    }
    const run = ++searchRunRef.current;
    setSearchQuickLoading(true);
    setSearchSlowLoading(true);
    setSearchDismissed(false);
    const timer = window.setTimeout(() => {
      client.account.searchQuick
        .query({ keyword: searchQuery, limit: 3 })
        .then((result) => {
          if (searchRunRef.current !== run) return;
          setSearchQuick(result as QuickSearchResult);
          setSearchQuickLoading(false);
        })
        .catch((err) => {
          if (searchRunRef.current !== run) return;
          console.error('[search] searchQuick failed', err);
          setSearchQuickLoading(false);
        });
      client.account.searchSlow
        .query({ keyword: searchQuery, limit: 3 })
        .then((result) => {
          if (searchRunRef.current !== run) return;
          setSearchSlow(result as SlowSearchResult);
          setSearchSlowLoading(false);
        })
        .catch((err) => {
          if (searchRunRef.current !== run) return;
          console.error('[search] searchSlow failed', err);
          setSearchSlowLoading(false);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [searchQuery, shell.view]);

  // Jump to a conversation, optionally centred on a message seq (files / chat
  // records). When no seq anchor exists, just open the chat (+toast on demand).
  const jumpToConvSeq = useCallback(
    (kind: 'group' | 'c2c', conv: string, seq?: string, toastOnMissingSeq = false): void => {
      setSearchDismissed(true);
      shell.setQuery('');
      if (!conv) return;
      if (!seq) {
        if (toastOnMissingSeq) pushToast({ tone: 'info', title: '未找到该消息位置' });
        shell.selectConversation(conv);
        return;
      }
      if (selectionRef.current?.id === conv) {
        // Already open — jump straight away.
        void centerWindowOnSeq(conv, kind, seq);
        return;
      }
      // Switch conversations; the listLatest effect performs the centred jump
      // once the placeholder newest page lands.
      pendingSearchJumpRef.current = { conv, kind, seq };
      shell.selectConversation(conv);
    },
    [centerWindowOnSeq, pushToast, shell],
  );

  // Click a search hit (dropdown / more modal): resolve conversation key + kind,
  // then jump. Files additionally carry a seq anchor.
  const openSearchHit = useCallback(
    (hit: SearchHit): void => {
      if (hit.category === 'chatRecord') {
        // 聊天记录卡片 → 打开双栏模态（左会话 / 右消息），而不是直接跳会话。
        setChatRecordsTarget({ hit, keyword: searchQuery });
        return;
      }
      const kind: 'group' | 'c2c' =
        hit.category === 'conversation'
          ? hit.chatType === 2
            ? 'group'
            : 'c2c'
          : hit.category === 'friend'
            ? 'c2c'
            : hit.category === 'groupMember'
              ? 'group'
              : hit.source === 'group'
                ? 'group'
                : 'c2c';
      const conv =
        hit.category === 'conversation' || hit.category === 'file'
          ? hit.targetUid
          : hit.category === 'friend'
            ? hit.uid
            : hit.groupCode;
      if (hit.category === 'file') {
        jumpToConvSeq(kind, conv, hit.msgSeq || undefined, true);
      } else {
        jumpToConvSeq(kind, conv);
      }
    },
    [jumpToConvSeq, searchQuery],
  );

  // Load the newest page whenever the open conversation changes. The render-time
  // reset already cleared `loaded`, so this never paints the old chat. Always a
  // fresh query — no react-query staleness — so switching back into a chat shows
  // messages that arrived while it was closed.
  useEffect(() => {
    if (!selectedUid || !(isDirect || isGroup)) {
      setMessagesLoading(false);
      return undefined;
    }
    const kind = isGroup ? 'group' : 'c2c';
    const conv = selectedUid;
    let cancelled = false;
    setMessagesLoading(true);
    client.account.listLatest
      .query({ kind, conv, limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setLoaded(page.map(toMessageWire).reverse()); // newest-first → ASC
        setHasOlder(page.length >= PAGE_SIZE);
        setAnchoredToLatest(true);
        setMessagesLoading(false);

        // A search hit was clicked for this conversation: don't leave the view
        // pinned to the latest — rebuild the window centred on the hit's seq.
        // This newest page is just a cheap placeholder it immediately replaces,
        // so we never load everything between latest and the target.
        const jump = pendingSearchJumpRef.current;
        if (jump && jump.conv === conv) {
          pendingSearchJumpRef.current = null;
          void centerWindowOnSeq(jump.conv, jump.kind, jump.seq);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[msgs] listLatest failed', err);
        setMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedUid, isDirect, isGroup, centerWindowOnSeq]);

  const requestOlderMessages = useCallback(
    (scroll: HTMLElement): void => {
      if (!selectedConversation || !hasOlder || loadingOlderRef.current) return;
      if (pendingScrollRestoreRef.current !== null) return;
      const minSeq = loaded[0]?.msgSeq;
      if (!minSeq) return;

      const kind = selectedConversation.type === 'group' ? 'group' : 'c2c';
      const conv = selectedConversation.id;
      loadingOlderRef.current = true;
      pendingScrollRestoreRef.current = {
        conversationId: conv,
        previousHeight: scroll.scrollHeight,
        previousTop: scroll.scrollTop,
      };

      client.account.listBefore
        .query({ kind, conv, beforeSeq: minSeq, limit: PAGE_SIZE })
        .then((older) => {
          loadingOlderRef.current = false;
          if (selectionRef.current?.id !== conv) {
            pendingScrollRestoreRef.current = null;
            return;
          }
          const known = new Set(loaded.map((m) => m.msgId));
          const fresh = older
            .map(toMessageWire)
            .reverse()
            .filter((m) => !known.has(m.msgId)); // ASC, older than the window
          if (fresh.length === 0) {
            pendingScrollRestoreRef.current = null;
            setHasOlder(false);
            return;
          }
          setLoaded((cur) => {
            const seen = new Set(cur.map((m) => m.msgId));
            const merged = fresh.filter((m) => !seen.has(m.msgId));
            return merged.length ? [...merged, ...cur] : cur;
          });
          if (older.length < PAGE_SIZE) setHasOlder(false);
        })
        .catch((err) => {
          loadingOlderRef.current = false;
          pendingScrollRestoreRef.current = null;
          console.error('[msgs] listBefore failed', err);
        });
    },
    [selectedConversation, hasOlder, loaded],
  );

  // Scroll-down paging for a detached "jump context" window: append the page of
  // messages just newer than the window's tail. Appending below the viewport
  // doesn't move it, so no scroll-restore is needed. When the tail reaches the
  // latest, re-anchor so live messages flow in again.
  const requestNewerMessages = useCallback((): void => {
    if (!selectedConversation || !hasNewer || loadingNewerRef.current) return;
    const maxSeq = loaded[loaded.length - 1]?.msgSeq;
    if (!maxSeq) return;

    const kind = selectedConversation.type === 'group' ? 'group' : 'c2c';
    const conv = selectedConversation.id;
    loadingNewerRef.current = true;

    client.account.listAfter
      .query({ kind, conv, afterSeq: maxSeq, limit: PAGE_SIZE })
      .then((newer) => {
        loadingNewerRef.current = false;
        if (selectionRef.current?.id !== conv) return;
        const known = new Set(loaded.map((m) => m.msgId));
        const fresh = newer.map(toMessageWire).filter((m) => !known.has(m.msgId)); // ASC, newer
        if (fresh.length > 0) {
          setLoaded((cur) => {
            const seen = new Set(cur.map((m) => m.msgId));
            const merged = fresh.filter((m) => !seen.has(m.msgId));
            return merged.length ? [...cur, ...merged] : cur;
          });
        }
        if (newer.length < PAGE_SIZE) {
          // Reached the tail — fold this window back into the live "latest" view.
          setHasNewer(false);
          setAnchoredToLatest(true);
        }
      })
      .catch((err) => {
        loadingNewerRef.current = false;
        console.error('[msgs] listAfter failed', err);
      });
  }, [selectedConversation, hasNewer, loaded]);

  useEffect(() => {
    if (!selectedConversation) return undefined;

    const scroll = document.querySelector<HTMLElement>('.weq-readonly-chat .message-scroll');
    if (!scroll) return undefined;
    const scrollElement = scroll;

    function maybeLoadEdge(): void {
      // Preload the previous page well before the user hits the very top — fire
      // once the scroll position is within the last 1/5 of a viewport from each
      // edge so new content streams in seamlessly instead of stalling at 0.
      const threshold = Math.max(32, scrollElement.clientHeight / 5);
      if (
        scrollElement.scrollTop <= threshold ||
        scrollElement.scrollHeight <= scrollElement.clientHeight + 32
      ) {
        requestOlderMessages(scrollElement);
      }
      if (
        scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight <=
        threshold
      ) {
        requestNewerMessages();
      }
    }

    scrollElement.addEventListener('scroll', maybeLoadEdge, { passive: true });
    const frame = window.requestAnimationFrame(maybeLoadEdge);

    return () => {
      scrollElement.removeEventListener('scroll', maybeLoadEdge);
      window.cancelAnimationFrame(frame);
    };
  }, [requestOlderMessages, requestNewerMessages, selectedConversation, templateMessages.length]);

  useLayoutEffect(() => {
    const restore = pendingScrollRestoreRef.current;
    if (!restore || restore.conversationId !== selectedConversation?.id) return undefined;

    const scroll = document.querySelector<HTMLElement>('.weq-readonly-chat .message-scroll');
    if (!scroll) return undefined;

    const apply = (): void => {
      scroll.scrollTop = Math.max(
        0,
        scroll.scrollHeight - restore.previousHeight + restore.previousTop,
      );
    };

    // Restore synchronously (before paint) so the freshly prepended page keeps the
    // reading position in a single layout pass. Deferring the whole restore with rAF
    // let the browser paint one frame where scrollHeight had already grown but
    // scrollTop was still at its old (near-top) value — which made the overlay
    // scrollbar thumb snap to the top and back ("上下乱串"). We re-apply once more on
    // the next frame in case a late reflow (e.g. a message measuring itself) shifts
    // the height; with a stable height this is a no-op, so no visible jitter.
    apply();
    const frame = window.requestAnimationFrame(() => {
      apply();
      pendingScrollRestoreRef.current = null;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [selectedConversation?.id, templateMessages.length]);

  useEffect(() => {
    if (!searchQuery) return undefined;
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setSearchDismissed(true);
    }
    function onMouseDown(event: MouseEvent): void {
      const target = event.target;
      if (target instanceof Element) {
        // Click inside the search box → restore the dropdown.
        if (target.closest('.search-box')) {
          setSearchDismissed(false);
          return;
        }
        // Click inside the dropdown itself → let them pick a result.
        if (target.closest('.weq-search-dropdown')) {
          return;
        }
      }
      // Click anywhere else in the sidebar body → temporarily hide the
      // dropdown so the user can reach the contact/group list underneath.
      setSearchDismissed(true);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [searchQuery]);

  function updateConversationPreference(
    conversationId: string,
    key: keyof ConversationPreference,
    value: boolean,
  ): void {
    setConversationPrefs((current) => ({
      ...current,
      [conversationId]: {
        ...fallbackPreference,
        ...current[conversationId],
        [key]: value,
      },
    }));
  }

  function updateDraft(_: string, __: string): void {
    // 只读浏览器暂不保存草稿，保留回调以满足模板接口。
  }

  async function noopAsync(): Promise<void> {
    return undefined;
  }

  // 独占整个内容区、不要左侧列表的视图（含主页）。
  const fullBleedView =
    shell.view === 'home' ||
    shell.view === 'export' ||
    shell.view === 'agentlab' ||
    shell.view === 'cache' ||
    shell.view === 'qzone' ||
    shell.view === 'channel';

  return (
    <ReplyJumpContext.Provider value={jumpToSeq}>
      <ForwardKindContext.Provider value={isGroup ? 'group' : 'c2c'}>
        <ConvContext.Provider value={isGroup ? (selectedConversation?.id ?? '') : ''}>
          <ChatShell
            user={user}
            view={shell.view}
            query={shell.query}
            contactTab={shell.contactTab}
            activeNotice={shell.contactNotice}
            sidebarWidth={fullBleedView ? 0 : shell.sidebarWidth}
            mainOpen={shell.mainOpen}
            messageBadgeCount={0}
            contactBadgeCount={0}
            showTools={false}
            railFooterContent={
              <RailAccountFooter
                currentUin={user.identityValue}
                currentName={user.displayName}
                currentAvatarUrl={user.avatarUrl}
              />
            }
            friendNoticeCount={contactRequests.length}
            groupNoticeCount={groupRequests.length}
            onViewChange={shell.switchView}
            onGoHome={() => shell.switchView('home')}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenCollection={() => setCollectionOpen(true)}
            onOpenMarketBrowser={() => setMarketBrowserOpen(true)}
            onOpenDressUp={() => setDressUpOpen(true)}
            onOpenProfile={noopAsync}
            onOpenAbout={noopAsync}
            onOpenHelp={noopAsync}
            onOpenInvite={noopAsync}
            onQueryChange={shell.setQuery}
            onQuickInvite={noopAsync}
            onCreateGroup={noopAsync}
            onOpenFriendNotices={() => shell.openContactNotice('friend')}
            onOpenGroupNotices={() => shell.openContactNotice('group')}
            onContactTabChange={shell.changeContactTab}
            onSidebarWidthChange={shell.updateSidebarWidth}
            sidebarContent={
              fullBleedView ? null : (
                <>
                  <ChatSidebarContent
                    user={user}
                    view={shell.view}
                    contactTab={shell.contactTab}
                    conversations={conversations}
                    activeConversationId={shell.activeConversationId}
                    selectedGroupConversationId={shell.selectedGroupConversationId}
                    selectedContactId={shell.selectedContactId}
                    conversationPrefs={conversationPrefs}
                    drafts={emptyDrafts}
                    contacts={buddyContacts}
                    query={shell.query}
                    onSelectConversation={handleSelectConversation}
                    onSelectContact={shell.selectContact}
                    onSelectGroup={shell.selectGroup}
                    activateToolsOnSelect={false}
                  />
                  {searchQuery && !searchDismissed ? (
                    <SearchDropdown
                      keyword={searchQuery}
                      quick={searchQuick}
                      quickLoading={searchQuickLoading}
                      slow={searchSlow}
                      slowLoading={searchSlowLoading}
                      onSelect={openSearchHit}
                      onMore={(category) => setSearchMore({ category, keyword: searchQuery })}
                    />
                  ) : null}
                  <OverlayScrollbar
                    targetSelector=".app-shell .sidebar-body"
                    className="weq-sidebar-scrollbar"
                    refreshKey={`sidebar:${shell.view}:${shell.query}`}
                  />
                </>
              )
            }
            mainContent={
              arkFeedState ? (
                <ArkFeedView
                  conversationId={arkFeedState.conversationId}
                  title={arkFeedState.title}
                  onBack={() => {
                    setArkFeedState(null);
                  }}
                  onEditMessage={async (msgId: string) => {
                    try {
                      const result = await client.account.getRawElements.query({ msgId });
                      if (result) {
                        setEditorState({ msgId, elements: result.elements });
                      }
                    } catch (e) {
                      console.error('[MainView] Failed to fetch raw elements:', e);
                    }
                  }}
                />
              ) : shell.view === 'home' ? (
                <ChatHome nickname={user.displayName} avatarUrl={user.avatarUrl} />
              ) : shell.view === 'export' ? (
                <ExportView />
              ) : shell.view === 'agentlab' ? (
                <AgentLabView />
              ) : shell.view === 'cache' ? (
                <CacheView />
              ) : shell.view === 'qzone' ? (
                <QzoneView />
              ) : shell.view === 'channel' ? (
                <ChannelView />
              ) : activeConversation?.type === 'merged' ? (
                <ArkFeedView
                  conversationId={activeConversation.id}
                  title={activeConversation.title}
                  onBack={shell.backConversation}
                  onEditMessage={async (msgId: string) => {
                    try {
                      const result = await client.account.getRawElements.query({ msgId });
                      if (result) {
                        setEditorState({ msgId, elements: result.elements });
                      }
                    } catch (e) {
                      console.error('[MainView] Failed to fetch raw elements:', e);
                    }
                  }}
                />
              ) : (
                <div className="weq-template-main-wrap">
                  <div className="weq-readonly-chat">
                    <ChatMainContent
                      user={user}
                      view={shell.view}
                      contactTab={shell.contactTab}
                      relationGraphSlot={<RelationGraphView />}
                      contactNotice={shell.contactNotice}
                      contactRequests={contactRequests}
                      groupRequests={groupRequests}
                      selectedContact={shell.selectedContact}
                      selectedGroupConversation={selectedGroupConversationForDetail}
                      activeConversation={activeConversation}
                      messages={templateMessages}
                      messageRenderers={messageRenderers}
                      loadingMessages={loadingInitialMessages}
                      atLatest={anchoredToLatest}
                      conversationPrefs={conversationPrefs}
                      drafts={emptyDrafts}
                      query={shell.query}
                      onAcceptContactRequest={noopAsync}
                      onRejectContactRequest={noopAsync}
                      onAcceptGroupRequest={noopAsync}
                      onRejectGroupRequest={noopAsync}
                      onMessageContact={noopAsync}
                      onMessageGroup={noopAsync}
                      onBackContact={shell.backContact}
                      onBackGroup={shell.backGroup}
                      onBackContactNotice={shell.backContactNotice}
                      onUpdateConversationPreference={updateConversationPreference}
                      onUpdateGroup={async (_conversationId: string, _input: GroupUpdateInput) =>
                        undefined
                      }
                      onLoadMoreGroupMembers={requestMoreGroupMembers}
                      groupMembersLoading={selectedGroupMembersLoading}
                      groupMembersError={selectedGroupMembersError}
                      onOpenNotificationSettings={noopAsync}
                      onSend={noopAsync}
                      onDraftChange={updateDraft}
                      onDraftClear={(_conversationId) => updateDraft(_conversationId, '')}
                      onBackConversation={shell.backConversation}
                      onEditRaw={handleEditRaw}
                      onDeleteMessage={handleDeleteMessage}
                      onOpenGroupAlbums={handleOpenGroupAlbums}
                      onOpenGroupFiles={handleOpenGroupFiles}
                      onOpenGroupAnnouncements={handleOpenGroupAnnouncements}
                      onOpenGroupEssence={handleOpenGroupEssence}
                      onOpenGroupAnalytics={handleOpenGroupAnalytics}
                      onOpenBuddyAnalytics={handleOpenBuddyAnalytics}
                      onOpenGroupMember={handleOpenGroupMember}
                      onAddMessage={handleAddMessage}
                      onViewDeleted={handleViewDeleted}
                      onViewRecalled={handleViewRecalled}
                      deletedIds={deletedIds}
                      onRestoreMessage={handleRestoreMessage}
                    />
                  </div>
                  <OverlayScrollbar
                    targetSelector=".weq-readonly-chat .message-scroll"
                    className="weq-message-scrollbar"
                    refreshKey={`messages:${selectedConversation?.id ?? 'none'}`}
                  />
                  <OverlayScrollbar
                    targetSelector=".weq-readonly-chat .group-info-member-list"
                    className="weq-group-members-scrollbar"
                    refreshKey={`group-members:${selectedConversation?.id ?? 'none'}`}
                  />
                </div>
              )
            }
          >
            {mergedPanel && (
              <MergedSessionPanel
                kind={mergedPanel.kind}
                conversations={conversations}
                profileByUid={profileByUid}
                groupNameByCode={groupNameByCode}
                anchorX={mergedPanel.anchorX}
                anchorY={mergedPanel.anchorY}
                onBack={() => setMergedPanel(null)}
                onSelectConversation={(conv) => {
                  if (mergedPanel.kind === 'official' || mergedPanel.kind === 'service') {
                    const title =
                      conv.type === 'group'
                        ? conv.group?.name || ''
                        : conv.otherUser?.displayName || '';
                    setArkFeedState({
                      kind: mergedPanel.kind,
                      conversationId: conv.id,
                      title,
                    });
                    // 优化：选中公众号/服务号会话后，取消其它会话（普通/隐藏）的选中态。
                    shell.backConversation();
                  } else {
                    // 从隐藏会话或删除会话选择器进入普通会话前，先关掉可能开着的 ARK Feed。
                    setArkFeedState(null);
                    shell.selectConversation(conv.id);
                  }
                }}
              />
            )}
          </ChatShell>

          {editorState ? (
            <MsgElementEditor
              msgId={editorState.msgId}
              elements={editorState.elements}
              onClose={() => setEditorState(null)}
              onSave={handleSaveRaw}
            />
          ) : null}

          <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          <CollectionDialog open={collectionOpen} onClose={() => setCollectionOpen(false)} />
          {marketBrowserOpen ? (
            <MarketEmojiBrowserLightbox onClose={() => setMarketBrowserOpen(false)} />
          ) : null}
          {dressUpOpen ? <DressUpDialog onClose={() => setDressUpOpen(false)} /> : null}
          {albumDialog ? (
            <GroupAlbumDialog
              groupCode={albumDialog.groupCode}
              groupName={albumDialog.groupName}
              onClose={() => setAlbumDialog(null)}
            />
          ) : null}
          {groupFileDialog ? (
            <GroupFileDialog
              groupCode={groupFileDialog.groupCode}
              groupName={groupFileDialog.groupName}
              onClose={() => setGroupFileDialog(null)}
            />
          ) : null}
          {analyticsDialog ? (
            <GroupAnalyticsDialog
              groupCode={analyticsDialog.groupCode}
              groupName={analyticsDialog.groupName}
              onClose={() => setAnalyticsDialog(null)}
            />
          ) : null}
          {buddyAnalyticsDialog ? (
            <BuddyAnalyticsDialog
              peerUid={buddyAnalyticsDialog.peerUid}
              peerName={buddyAnalyticsDialog.peerName}
              onClose={() => setBuddyAnalyticsDialog(null)}
            />
          ) : null}
          {announcementsDialog ? (
            <GroupAnnouncementsDialog
              groupCode={announcementsDialog.groupCode}
              groupName={announcementsDialog.groupName}
              currentAnnouncement={
                selectedConversation?.type === 'group' &&
                selectedConversation.id === announcementsDialog.groupCode
                  ? selectedConversation.group?.announcement
                  : null
              }
              bulletins={((groupBulletins.data ?? []) as GroupBulletinWire[]).map(
                (bulletin, _index) => {
                  // publisherUid 可能是 UID（数据库）或 UIN（Web API），尝试两者匹配
                  const publisher = currentGroupMembers.find(
                    (m) =>
                      m.id === bulletin.publisherUid || m.identityValue === bulletin.publisherUid,
                  );
                  return {
                    ...bulletin,
                    publisherName: publisher?.displayName,
                    publisherAvatar: publisher?.avatarUrl ?? undefined,
                  };
                },
              )}
              onClose={() => setAnnouncementsDialog(null)}
            />
          ) : null}
          {essenceDialog ? (
            <GroupEssenceDialog
              groupCode={essenceDialog.groupCode}
              groupName={essenceDialog.groupName}
              essenceMessages={(() => {
                const essence = (groupEssence.data ?? []) as GroupEssenceWire[];
                const essenceWeb = groupEssenceWeb.data ?? [];
                return essence.map((item): GroupEssenceDisplay => {
                  const webItem = essenceWeb.find((web) => web.msgSeq === item.msgSeq);
                  return {
                    id: `essence:${item.msgSeq}:${item.timestamp}`,
                    msgSeq: item.msgSeq,
                    senderName: item.senderNick,
                    operatorName: item.operatorNick,
                    createdAt: secondsToIsoTime(item.timestamp) ?? new Date(0).toISOString(),
                    active: item.setStatus === 1,
                    content: webItem?.content,
                    senderTime: webItem?.senderTime ? String(webItem.senderTime) : undefined,
                    canRemove: webItem?.canRemove,
                  };
                });
              })()}
              onClose={() => setEssenceDialog(null)}
              onJumpToMessage={(seq) => {
                setEssenceDialog(null);
                if (seq == null) {
                  console.warn('[essence-jump] missing msgSeq, cannot jump', seq);
                  return;
                }
                jumpToSeq({ seq });
              }}
            />
          ) : null}
          {memberCard ? (
            <MemberProfileCard
              member={memberCard.member}
              anchor={memberCard.anchor}
              onClose={() => setMemberCard(null)}
            />
          ) : null}
          {addMessageConv ? (
            <AddMessageModal
              conversation={addMessageConv}
              selfUser={user}
              selfUid={selfProfile.data?.uid}
              onClose={() => setAddMessageConv(null)}
              onInserted={() => void refreshWindow()}
            />
          ) : null}
          {deletedConv ? (
            <DeletedMessagesModal
              conversation={deletedConv}
              user={user}
              messages={deletedTemplateMessages}
              renderers={messageRenderers}
              loading={deletedLoading}
              onRestore={handleRestoreMessage}
              onClose={() => {
                setDeletedConv(null);
                setDeletedWires([]);
              }}
            />
          ) : null}
          {recalledConv ? (
            <RecalledMessagesModal
              conversation={recalledConv}
              user={user}
              messages={recalledTemplateMessages}
              renderers={messageRenderers}
              loading={recalledLoading}
              onJumpToMessage={(seq) => {
                setRecalledConv(null);
                setRecalledWires([]);
                if (seq == null) {
                  console.warn('[recall-jump] missing msgSeq, cannot jump', seq);
                  return;
                }
                jumpToSeq({ seq });
              }}
              onClose={() => {
                setRecalledConv(null);
                setRecalledWires([]);
              }}
            />
          ) : null}
          {searchMore ? (
            <UnifiedSearchModal
              category={searchMore.category}
              initialKeyword={searchMore.keyword}
              onClose={() => setSearchMore(null)}
              onSelect={openSearchHit}
              onOpenChatRecords={(hit) => {
                setSearchMore(null);
                setChatRecordsTarget({
                  hit: hit as ChatRecordSearchHit,
                  keyword: searchMore.keyword,
                });
              }}
            />
          ) : null}
          {chatRecordsTarget ? (
            <ChatRecordsModal
              initialHit={chatRecordsTarget.hit}
              initialKeyword={chatRecordsTarget.keyword}
              onClose={() => setChatRecordsTarget(null)}
              onJumpMessage={({ source, targetUid, msgSeq }) =>
                jumpToConvSeq(source === 'group' ? 'group' : 'c2c', targetUid, msgSeq)
              }
              pushToast={pushToast}
            />
          ) : null}
        </ConvContext.Provider>
      </ForwardKindContext.Provider>
    </ReplyJumpContext.Provider>
  );
}
