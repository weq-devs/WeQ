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
import { LogOut, X } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { client } from '../trpc/client';
import {
  ChatMainContent,
  ChatShell,
  ChatSidebarContent,
  composeMessageRenderers,
  type Contact,
  type Conversation,
  type ConversationDrafts,
  type ConversationPreference,
  type ConversationPreferences,
  type GroupMember,
  type GroupUpdateInput,
  type Message,
  type MessageRenderer,
  type User,
  useChatShellController,
} from '../im-template/template';
import { qqMessageRenderer, ReplyJumpContext, type ReplyJumpTarget } from '../components/QqMessageContent';

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
};

type MessageWire = {
  msgId: string;
  /** In-conversation sequence number (column 40003); the seq-window cursor. */
  msgSeq: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  elements: unknown[];
};

/** One full-text search hit from `account.searchMessages`. */
type MsgSearchHitWire = {
  msgId: string;
  /** In-conversation seq (column 40003) — the click-to-jump anchor. */
  msgSeq: string;
  /** ChatType: 2 = group, others = c2c. */
  chatType: number;
  /** Conversation key: group code (group) or peer uid (c2c). */
  targetUid: string;
  senderUid: string;
  sendTime: string;
  content: string;
  fileName?: string;
};

/** ChatType 2 = group; everything else treated as a 1-1 (c2c) chat. */
function isGroupChatType(chatType: number): boolean {
  return chatType === 2;
}

/**
 * Build a one-line snippet around the first keyword match and split it into
 * highlighted / plain runs (case-insensitive). Keeps ~10 chars of left context
 * and trims the whole snippet to ~46 chars so the dropdown row stays compact.
 */
function highlightSnippet(content: string, keyword: string): Array<{ text: string; hit: boolean }> {
  const text = content.replace(/\s+/g, ' ').trim();
  const needle = keyword.trim();
  if (!needle) return [{ text: text.slice(0, 46), hit: false }];

  const lower = text.toLowerCase();
  const lneedle = needle.toLowerCase();
  const first = lower.indexOf(lneedle);

  // Window the snippet around the first hit so a long message still shows it.
  let start = 0;
  let prefix = '';
  if (first > 12) {
    start = first - 10;
    prefix = '…';
  }
  const windowed = text.slice(start, start + 46);
  const runs: Array<{ text: string; hit: boolean }> = [];
  if (prefix) runs.push({ text: prefix, hit: false });

  const wLower = windowed.toLowerCase();
  let i = 0;
  for (;;) {
    const at = wLower.indexOf(lneedle, i);
    if (at === -1) {
      if (i < windowed.length) runs.push({ text: windowed.slice(i), hit: false });
      break;
    }
    if (at > i) runs.push({ text: windowed.slice(i, at), hit: false });
    runs.push({ text: windowed.slice(at, at + needle.length), hit: true });
    i = at + needle.length;
  }
  return runs;
}

/** Short, locale time/date for a search hit (today → HH:MM, else M/D). */
function searchHitTime(sendTimeSeconds: string): string {
  const secs = Number(sendTimeSeconds);
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const d = new Date(secs * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** The unified chat-message wire from the account router → local MessageWire. */
type ChatMsgWire = {
  msgId: string;
  msgSeq: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  elements: unknown[];
};

function toMessageWire(w: ChatMsgWire): MessageWire {
  return {
    msgId: w.msgId,
    msgSeq: w.msgSeq,
    senderUid: w.senderUid,
    senderUin: w.senderUin,
    sendTime: w.sendTime,
    elements: w.elements,
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

type GroupBulletinWire = {
  publisherUid: string;
  fid: string;
  msgTime: string;
  ctime: string;
  textContent: string;
};

type GroupEssenceWire = {
  msgSeq: number;
  senderNick: string;
  setStatus: number;
  operatorNick: string;
  timestamp: number;
};

type GroupMemberLevelInfoWire = {
  memberLevel: number;
  levelConfigs: Array<{ level: number; levelName: string }>;
};

type RenderElementWire = {
  type?: string;
  data?: Record<string, unknown>;
};

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
function avatarSrc(c: Pick<RecentContactWire, 'chatType' | 'targetUid' | 'targetUin'>): string | null {
  const t = String(c.chatType);
  if (t.includes('GROUP')) return `https://p.qlogo.cn/gh/${c.targetUid}/${c.targetUid}/0`;
  if (t.includes('C2C') && c.targetUin && c.targetUin !== '0') {
    return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${c.targetUin}`;
  }
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

function chatTypeKind(chatType: string | number): 'direct' | 'group' | null {
  const s = String(chatType);
  if (s.includes('C2C')) return 'direct';
  if (s.includes('GROUP')) return 'group';
  return null;
}

function toIsoTime(seconds: string | undefined): string {
  return secondsToIsoTime(seconds) ?? new Date(0).toISOString();
}

function contactTitle(c: RecentContactWire): string {
  return c.targetDisplayName || c.targetRemark || c.senderDisplayName || c.senderNick || c.targetUid;
}

function previewText(preview: unknown): string | null {
  if (!preview || typeof preview !== 'object') return null;
  const value = (preview as { displayText?: unknown }).displayText;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

function genderLabel(value?: number): string | null {
  if (value === 1) return '男';
  if (value === 2) return '女';
  return null;
}

function buddyToContact(
  buddy: BuddyWire,
  profileByUid: Map<string, UserProfileWire>,
  categoryById: Map<number, CategoryWire>,
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
    avatarUrl: senderAvatarSrc(buddy.uin) || profile?.avatarUrl || null,
    signature: profile?.signature || null,
    createdAt: new Date(0).toISOString(),
    categoryId: buddy.categoryId,
    categoryName: category?.name || null,
    qid: buddy.qid || profile?.qid || null,
    remark: profile?.remark || null,
    age: profile?.age,
    gender: profile?.gender,
    intimacy: profile?.intimacy,
    customStatus,
    onlineStatus: customStatus,
  };
}

function groupDetailToConversation(
  detail: GroupDetailWire,
  fallback?: Conversation | null,
  user?: User,
): Conversation {
  const updatedAt = fallback?.updatedAt ?? secondsToIsoTime(detail.createTime) ?? new Date(0).toISOString();
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
      customLabels: detail.customLabels.map((label) => label.content).filter((label): label is string => Boolean(label)),
      addressName: detail.address?.locationName || null,
    },
    members: fallback?.type === 'group' ? fallback.members : user ? [{ ...user, role: 'member', joinedAt: updatedAt }] : [],
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

function buddyRequestToContactRequest(request: BuddyRequestWire, profileByUid: Map<string, UserProfileWire>) {
  const profile = profileByUid.get(request.peerUid);
  const uin = profile?.uin ?? '';
  const contact: Contact = {
    id: request.peerUid,
    identityLabel: uin && uin !== '0' ? 'QQ' : 'UID',
    identityValue: uin && uin !== '0' ? uin : request.peerUid,
    username: request.peerUid,
    displayName: request.nick || displayProfileName(profile) || request.peerUid,
    avatarUrl: senderAvatarSrc(uin) || profile?.avatarUrl || null,
    signature: profile?.signature || null,
    createdAt: secondsToIsoTime(request.timestamp) ?? new Date(0).toISOString(),
  };

  return {
    id: `buddy-request:${request.peerUid}:${request.timestamp}`,
    direction: request.initiator === 1 ? 'incoming' : 'outgoing',
    status: requestStatus(request.status),
    message: request.verifyMsg || request.source || null,
    createdAt: contact.createdAt,
    respondedAt: null,
    user: contact,
  } as const;
}

function groupRequestFromBuddyRequest(request: BuddyRequestWire, groupsById: Map<string, Conversation>, profileByUid: Map<string, UserProfileWire>) {
  if (!request.sourceGroupCode || request.sourceGroupCode === '0') return null;
  const groupConversation = groupsById.get(request.sourceGroupCode);
  if (!groupConversation || groupConversation.type !== 'group') return null;
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

function levelNameFor(levelConfigs: Array<{ level: number; levelName: string }>, level?: number): string | null {
  if (level === undefined || level === 0) return null;
  const bracket = levelBracketFor(level);
  return levelConfigs.find((item) => item.level === bracket)?.levelName || `Lv${level}`;
}

function contactToConversation(c: RecentContactWire, user: User): Conversation | null {
  const kind = chatTypeKind(c.chatType);
  const title = contactTitle(c);
  const preview = previewText(c.preview);
  const updatedAt = toIsoTime(c.sendTime);
  const lastMessage = {
    id: `preview:${c.targetUid}:${c.sendTime}`,
    senderId: c.senderUid || null,
    senderDisplayName: c.senderDisplayName || c.senderNick || null,
    body: preview,
    createdAt: updatedAt,
  };

  if (kind === 'direct') {
    const otherUser: User = {
      id: c.targetUid,
      identityLabel: c.targetUin && c.targetUin !== '0' ? 'QQ' : 'UID',
      identityValue: c.targetUin && c.targetUin !== '0' ? c.targetUin : c.targetUid,
      username: c.targetUid,
      displayName: title,
      avatarUrl: avatarSrc(c),
    };

    return {
      id: c.targetUid,
      type: 'direct',
      updatedAt,
      otherUser,
      group: null,
      members: [],
      preference: fallbackPreference,
      unreadCount: 0,
      lastMessage,
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
      preference: fallbackPreference,
      unreadCount: 0,
      lastMessage,
    };
  }

  return null;
}

function isMineMessage(message: MessageWire, user: User): boolean {
  if (message.senderUin && message.senderUin === user.identityValue) return true;
  return message.elements.some((element) => {
    const data = (element as RenderElementWire | null)?.data;
    return data?.isSender === true;
  });
}

function messageSender(message: MessageWire, conversation: Conversation, user: User, memberMap?: Map<string, GroupMember>): User {
  if (isMineMessage(message, user)) return user;
  if (conversation.type === 'direct') return conversation.otherUser;

  // Optimized O(1) lookup
  const member = memberMap?.get(message.senderUid);
  const isUinOnly = !member?.displayName || member.displayName === message.senderUin;

  return {
    id: message.senderUid || `sender:${message.senderUin}`,
    identityLabel: message.senderUin && message.senderUin !== '0' ? 'QQ' : 'UID',
    identityValue: message.senderUin && message.senderUin !== '0' ? message.senderUin : message.senderUid,
    username: message.senderUid || message.senderUin,
    displayName: member?.displayName || (message.senderUin && message.senderUin !== '0' ? message.senderUin : 'Member'),
    avatarUrl: member?.avatarUrl || senderAvatarSrc(message.senderUin),
    // Ensure group specific fields are passed through, but ONLY if it's not just a UIN display
    role: !isUinOnly ? member?.role : undefined,
    customTitle: !isUinOnly ? member?.customTitle : undefined,
    levelName: !isUinOnly ? member?.levelName : undefined,
    levelBracket: !isUinOnly ? levelBracketFor(member?.memberLevel) : 0,
  } as User;
}

function messageToTemplate(message: MessageWire, conversation: Conversation, user: User, memberMap?: Map<string, GroupMember>): Message {
  const sender = messageSender(message, conversation, user, memberMap);
  return {
    id: message.msgId,
    conversationId: conversation.id,
    senderId: sender.id,
    sender,
    body: messageBody(message.elements),
    createdAt: toIsoTime(message.sendTime),
    // Raw render-view elements for the QQ face renderer (qqFaceMessageRenderer).
    // `body` stays the text fallback for previews and non-face messages.
    qqElements: message.elements,
  } as Message & { qqElements: unknown[] };
}

function messageBody(elements: unknown[]): string {
  const parts = elements.map(elementText).filter(Boolean);
  return parts.length > 0 ? parts.join('') : '[Unsupported message]';
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
    case 'onlineFile':
    case 'onlineFolder':
      return attachmentText('File', data, 'fileName');
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
    case 'grayTipGroup':
      return '[Group notice]';
    case 'ark':
      return fencedJson('Ark', stringField(data, 'arkData'));
    case 'markdown':
      return stringField(data, 'markdownContent') || stringField(data, 'markdownTextSummary') || '[Markdown]';
    case 'multiMsg':
      return '[Merged messages]';
    case 'call':
      return arraySummary(data, 'callSummary') || '[Call]';
    case 'wallet':
      return '[Wallet message]';
    case 'mface':
      return '[Sticker]';
    case 'emojiBounce':
      return stringField(data, 'emojiBounceTextSummary') || stringField(data, 'emojiBouncePcText') || '[Emoji interaction]';
    case 'qqDynamic':
      return '[QQ Dynamic]';
    case 'unknown':
      return '[Unsupported message]';
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

function attachmentText(label: string, data: Record<string, unknown>, nameKey: string, summaryKey?: string): string {
  const summary = summaryKey ? arraySummary(data, summaryKey) : '';
  const name = stringField(data, nameKey);
  return summary || (name ? `[${label}] ${name}` : `[${label}]`);
}

function quoteText(label: string, data: Record<string, unknown>, key: string): string {
  const text = stringField(data, key);
  return text ? `> ${text}` : `[${label}]`;
}

function fencedJson(label: string, value: string): string {
  if (!value) return `[${label}]`;
  return `**${label}**\n\n\`\`\`json\n${value}\n\`\`\``;
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
    const trackHeight = Math.max(0, scrollTarget.getBoundingClientRect().height - OVERLAY_SCROLLBAR_INSET * 2);
    const maxThumbTravel = Math.max(1, trackHeight - state.thumbHeight);

    function handlePointerMove(moveEvent: PointerEvent): void {
      const delta = moveEvent.clientY - startY;
      scrollTarget.scrollTop = clamp(startScrollTop + (delta / maxThumbTravel) * maxScrollTop, 0, maxScrollTop);
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
  const contacts = trpc.account.listRecentContacts.useQuery();
  const selfProfile = trpc.account.getSelfProfile.useQuery();
  const buddies = trpc.account.listBuddies.useQuery({ limit: 2000 });
  const categories = trpc.account.listCategories.useQuery();
  const profiles = trpc.account.listProfiles.useQuery({ limit: 2000 });
  const buddyRequests = trpc.account.listBuddyRequests.useQuery({ limit: 2000 });
  const allGroups = trpc.account.listAllGroups.useQuery({ limit: 2000 });
  const openedUin = useViewState((s) => s.openedUin);
  const goTo = useViewState((s) => s.goTo);
  const setOpenedUin = useViewState((s) => s.setOpenedUin);
  // Seq-window message model: a single ASC (oldest→newest) list for the open
  // conversation, plus whether it still reaches the latest message and whether
  // older history remains. `loaded[0].msgSeq` is the window's lower cursor.
  const [loaded, setLoaded] = useState<MessageWire[]>([]);
  const [anchoredToLatest, setAnchoredToLatest] = useState(true);
  const [hasOlder, setHasOlder] = useState(true);
  // True only in a "jump context" window (anchored=false) that has newer
  // messages below it; drives scroll-down paging via `requestNewerMessages`.
  const [hasNewer, setHasNewer] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [trackedConversationId, setTrackedConversationId] = useState<string | null>(null);
  const [conversationPrefs, setConversationPrefs] = useState<ConversationPreferences>({});
  const [templateCreditOpen, setTemplateCreditOpen] = useState(false);
  const [onlineStatusByUid, setOnlineStatusByUid] = useState<Record<string, string>>({});
  const [groupMemberPages, setGroupMemberPages] = useState<Record<string, GroupMemberWire[]>>({});
  const [groupMemberHasMore, setGroupMemberHasMore] = useState<Record<string, boolean>>({});
  const [groupMemberLoading, setGroupMemberLoading] = useState<Record<string, boolean>>({});
  const groupMemberLoadingRef = useRef<Record<string, boolean>>({});
  // Off-page message senders resolved on demand, keyed by groupCode → uid so a
  // member cached for one group never leaks into another (and per-group cards
  // don't collide across groups).
  const [missingMembers, setMissingMembers] = useState<Record<string, Record<string, GroupMemberWire>>>({});
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);

  // Global message search (sidebar search box → dropdown of ≤5 hits).
  const [searchHits, setSearchHits] = useState<MsgSearchHitWire[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  // uid → nickname resolved from profile_info.db for search-result senders.
  const [searchNicks, setSearchNicks] = useState<Record<string, string>>({});
  // Set when a search hit was clicked: the listLatest effect, after the target
  // conversation's newest page lands, rebuilds the window centred on this seq
  // instead of leaving the view pinned to the latest.
  const pendingSearchJumpRef = useRef<{ conv: string; kind: 'group' | 'c2c'; seq: string } | null>(null);

  // Mirror of `loaded` for the reply-jump handler (a stable callback that must
  // read the current window without being re-created on every message change).
  const loadedRef = useRef<MessageWire[]>([]);
  const pendingScrollRestoreRef = useRef<PendingScrollRestore | null>(null);
  // Latest active-conversation identity, read by the once-mounted live
  // subscription (which must not re-subscribe on every selection change).
  const selectionRef = useRef<{ id: string; kind: 'direct' | 'group' } | null>(null);
  // Current loaded-window descriptor, read by the once-mounted subscription.
  const windowRef = useRef<{ minSeq: string | null; anchored: boolean }>({
    minSeq: null,
    anchored: true,
  });

  const user = useMemo(() => currentUser(openedUin, selfProfile.data), [openedUin, selfProfile.data]);
  const profileByUid = useMemo(() => {
    return new Map(((profiles.data ?? []) as UserProfileWire[]).map((profile) => [profile.uid, profile]));
  }, [profiles.data]);
  const categoryById = useMemo(() => {
    return new Map(((categories.data ?? []) as CategoryWire[]).map((category) => [category.id, category]));
  }, [categories.data]);
  const buddyContacts = useMemo(
    () =>
      ((buddies.data ?? []) as BuddyWire[]).map((buddy) =>
        {
          const contact = buddyToContact(buddy, profileByUid, categoryById);
          return {
            ...contact,
            onlineStatus: onlineStatusByUid[buddy.uid] || contact.onlineStatus,
          };
        },
      ),
    [buddies.data, categoryById, onlineStatusByUid, profileByUid],
  );
  const conversations = useMemo(
    () => {
      const recentConversations = ((contacts.data ?? []) as RecentContactWire[])
        .map((contact) => contactToConversation(contact, user))
        .filter((conversation): conversation is Conversation => conversation !== null);
      const byId = new Map(recentConversations.map((conversation) => [conversation.id, conversation]));

      for (const detail of (allGroups.data ?? []) as GroupDetailWire[]) {
        byId.set(detail.groupCode, groupDetailToConversation(detail, byId.get(detail.groupCode), user));
      }

      return Array.from(byId.values()).sort((a, b) => {
        const aTime = Date.parse(a.updatedAt);
        const bTime = Date.parse(b.updatedAt);
        return bTime - aTime;
      });
    },
    [allGroups.data, contacts.data, user],
  );
  const groupsById = useMemo(() => new Map(conversations.map((conversation) => [conversation.id, conversation])), [conversations]);
  const contactRequests = useMemo(
    () =>
      ((buddyRequests.data ?? []) as BuddyRequestWire[])
        .filter((request) => !request.sourceGroupCode || request.sourceGroupCode === '0')
        .map((request) => buddyRequestToContactRequest(request, profileByUid)),
    [buddyRequests.data, profileByUid],
  );
  const groupRequests = useMemo(
    () =>
      ((buddyRequests.data ?? []) as BuddyRequestWire[])
        .map((request) => groupRequestFromBuddyRequest(request, groupsById, profileByUid))
        .filter((request): request is NonNullable<typeof request> => request !== null),
    [buddyRequests.data, groupsById, profileByUid],
  );
  const shellHistory = useMemo(
    () => ({
      isMobileShell,
      shouldAutoSelectConversation: () => true,
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
    sidebarWidthStorageKey: 'weq.desktop.sidebarWidth.v2',
    history: shellHistory,
  });

  const selectedConversation = shell.activeConversation;
  const selectedUid = selectedConversation?.id ?? '';
  const isGroup = selectedConversation?.type === 'group';
  const isDirect = selectedConversation?.type === 'direct';

  useEffect(() => {
    const buddyList = ((buddies.data ?? []) as BuddyWire[]).slice(0, 300);
    if (buddyList.length === 0) return undefined;
    let cancelled = false;

    async function loadOnlineStatuses(): Promise<void> {
      const next: Record<string, string> = {};
      const batchSize = 12;
      for (let index = 0; index < buddyList.length && !cancelled; index += batchSize) {
        const batch = buddyList.slice(index, index + batchSize);
        const statuses = await Promise.all(
          batch.map(async (buddy) => {
            try {
              const status = await client.account.getOnlineStatus.query({ uid: buddy.uid });
              return status?.displayStatus ? [buddy.uid, status.displayStatus] as const : null;
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
  const groupLevelInfo = trpc.account.getGroupMemberLevelInfo.useQuery(
    { groupCode: selectedUid },
    { enabled: Boolean(selectedUid && isGroup) },
  );
  const selectedGroupMemberWires = isGroup ? (groupMemberPages[selectedUid] ?? []) : [];
  const selectedGroupMembersLoading = Boolean(isGroup && groupMemberLoading[selectedUid]);
  const selectedGroupMembersHasMore = Boolean(isGroup && groupMemberHasMore[selectedUid]);

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

        if (selectionRef.current?.id !== groupCode) return;

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
      } catch (err) {
        console.error('[group-members] listGroupMembers failed', err);
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
    if (!selectedUid || !isGroup || selectedGroupMembersLoading) return;
    if (selectedGroupMemberWires.length > 0 && !selectedGroupMembersHasMore) return;
    void loadGroupMembersPage(selectedUid, selectedGroupMemberWires.length);
  }, [
    isGroup,
    loadGroupMembersPage,
    selectedGroupMemberWires.length,
    selectedGroupMembersHasMore,
    selectedGroupMembersLoading,
    selectedUid,
  ]);

  useEffect(() => {
    if (!selectedUid || !isGroup) return;
    if (selectedGroupMemberWires.length > 0 || selectedGroupMembersLoading) return;
    requestMoreGroupMembers();
  }, [
    isGroup,
    requestMoreGroupMembers,
    selectedGroupMemberWires.length,
    selectedGroupMembersLoading,
    selectedUid,
  ]);

  // `loaded` is already oldest→newest; the template renders in array order.
  const loadedMessageWires = loaded;
  const currentGroupMembers = useMemo(() => {
    if (!selectedConversation || selectedConversation.type !== 'group') return [];
    
    const detail = groupDetail.data;
    const levelConfigs = groupLevelInfo.data?.levelConfigs ?? [];

    const allMemberWires = [...selectedGroupMemberWires];
    // Merge in only THIS group's on-demand-resolved senders.
    const groupMissing = missingMembers[selectedUid] ?? {};
    Object.values(groupMissing).forEach(m => {
      if (!allMemberWires.find(em => em.uid === m.uid)) {
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
      role: m.uid === detail?.ownerUid ? 'owner' : (m.adminFlag > 0 ? 'admin' : 'member'),
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
  }, [selectedConversation, selectedUid, groupDetail.data, groupLevelInfo.data, selectedGroupMemberWires, missingMembers]);

  // Asynchronously resolve message senders missing from the loaded member page.
  // Messages render immediately with the uin fallback; this batch-fetches the
  // real card/nick/group-title from the DB and patches them in without blocking.
  useEffect(() => {
    if (!selectedUid || !isGroup || loaded.length === 0) return;

    const groupCode = selectedUid;
    const known = new Set(selectedGroupMemberWires.map((m) => m.uid));
    const resolved = missingMembers[groupCode] ?? {};
    const unknownUids = [...new Set(loaded.map((m) => m.senderUid))].filter(
      (uid) => uid && !known.has(uid) && !resolved[uid],
    );
    if (unknownUids.length === 0) return;

    let cancelled = false;
    void (async () => {
      // The endpoint caps at 200 uids per call; chunk larger sets.
      for (let i = 0; i < unknownUids.length; i += 200) {
        const chunk = unknownUids.slice(i, i + 200);
        try {
          const members = await client.account.getGroupMembersByUids.query({ groupCode, uids: chunk });
          if (cancelled || selectionRef.current?.id !== groupCode) return;
          if (members.length > 0) {
            setMissingMembers((prev) => {
              const groupCache = { ...(prev[groupCode] ?? {}) };
              for (const member of members) groupCache[member.uid] = member;
              return { ...prev, [groupCode]: groupCache };
            });
          }
        } catch (err) {
          console.error('[group-members] getGroupMembersByUids failed', err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loaded, selectedUid, isGroup, selectedGroupMemberWires, missingMembers]);

  const templateMessages = useMemo(() => {
    if (!selectedConversation) return [];
    
    // Create a fast lookup map for member info
    const memberMap = new Map(currentGroupMembers.map(m => [m.id, m]));
    
    return loadedMessageWires.map((message) => 
      messageToTemplate(message, selectedConversation, user, memberMap)
    );
  }, [loadedMessageWires, selectedConversation, user, currentGroupMembers]);

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
        customLabels: detail?.customLabels
          ?.map((label) => label.content)
          .filter((label): label is string => Boolean(label)) ?? [],
        addressName: detail?.address?.locationName || null,
        bulletins: ((groupBulletins.data ?? []) as GroupBulletinWire[]).map((bulletin, index) => ({
          id: bulletin.fid || `bulletin:${index}`,
          text: bulletin.textContent,
          createdAt: secondsToIsoTime(bulletin.ctime) ?? secondsToIsoTime(bulletin.msgTime) ?? new Date(0).toISOString(),
          publisherUid: bulletin.publisherUid,
        })),
        essenceMessages: ((groupEssence.data ?? []) as GroupEssenceWire[]).map((item) => ({
          id: `essence:${item.msgSeq}:${item.timestamp}`,
          msgSeq: item.msgSeq,
          senderName: item.senderNick,
          operatorName: item.operatorNick,
          createdAt: secondsToIsoTime(item.timestamp) ?? new Date(0).toISOString(),
          active: item.setStatus === 1,
        })),
        levelConfigs: (groupLevelInfo.data?.levelConfigs ?? []).map((item) => ({
          level: item.level,
          name: item.levelName,
        })),
        role: currentGroupMembers.find(m => m.id === user.id)?.role || 'member',
      },
    };
  }, [
    selectedConversation,
    currentGroupMembers,
    groupBulletins.data,
    groupDetail.data,
    groupEssence.data,
    groupLevelInfo.data,
    user,
  ]);
  // "loading" only until the first page lands; gating on this (not react-query)
  // keeps a switch-into from flashing "还没有消息" before the query resolves.
  const loadingInitialMessages =
    Boolean(selectedConversation) && messagesLoading && loaded.length === 0;

  useEffect(() => {
    if (contacts.isLoading) return;
    // Don't auto-open the first conversation: land on the empty placeholder and
    // let the user pick. Only clear a selection that no longer exists.
    if (
      shell.activeConversationId &&
      !conversations.some((conversation) => conversation.id === shell.activeConversationId)
    ) {
      shell.setActiveConversationId(null);
    }
  }, [contacts.isLoading, conversations, shell.activeConversationId, shell.setActiveConversationId]);

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
      let before;
      let after;
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
        console.error('[jump] centerWindowOnSeq failed', err);
        return false;
      }
      if (selectionRef.current?.id !== conv) return false; // switched away mid-flight

      const seen = new Set<string>();
      const merged: MessageWire[] = [];
      // before is DESC (newest-first) incl. centre → reverse to ASC; after is ASC.
      for (const m of [...before.map(toMessageWire).reverse(), ...after.map(toMessageWire)]) {
        if (seen.has(m.msgId)) continue;
        seen.add(m.msgId);
        merged.push(m);
      }

      const target = merged.find((m) => m.msgSeq === targetSeq);
      if (!target) return false; // not in DB (e.g. recalled) — leave the view as-is

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
    [scrollToMsgId],
  );

  // Scroll the loaded message list to a reply target, loading older pages first
  // if it isn't in the window yet, then briefly flash it. The 40003 anchor lives
  // in a different reply field per kind (verified against the live DB):
  //   group → origMsgSeq (47402);  c2c → origMsgIndex (47419).
  const jumpToSeq = useCallback(async (jumpTarget: ReplyJumpTarget): Promise<void> => {
    const sel = selectionRef.current;
    if (!sel) return;
    const kind: 'group' | 'c2c' = sel.kind === 'group' ? 'group' : 'c2c';
    const rawSeq =
      kind === 'group' ? (jumpTarget.seq ?? jumpTarget.index) : (jumpTarget.index ?? jumpTarget.seq);
    if (rawSeq === undefined || rawSeq === null || rawSeq === '') return;
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
      if (!minSeq || Number(minSeq) <= targetNum) break;
      if (working.some((m) => m.msgSeq === targetSeq)) break;
      let older;
      try {
        older = await client.account.listBefore.query({ kind, conv: sel.id, beforeSeq: minSeq, limit: PAGE_SIZE });
      } catch (err) {
        console.error('[reply-jump] listBefore failed', err);
        break;
      }
      if (selectionRef.current?.id !== sel.id) return; // switched away mid-flight
      const known = new Set(working.map((m) => m.msgId));
      const fresh = older.map(toMessageWire).reverse().filter((m) => !known.has(m.msgId));
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
  }, [centerWindowOnSeq, scrollToMsgId]);

  // Debounced global message search: as the user types, search buddy+group and
  // show up to 5 hits. A run counter discards stale responses so only the last
  // keystroke's results win.
  const searchQuery = shell.query.trim();
  const searchRunRef = useRef(0);
  useEffect(() => {
    if (!searchQuery) {
      setSearchHits([]);
      setSearchOpen(false);
      setSearchLoading(false);
      return undefined;
    }
    const run = ++searchRunRef.current;
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      client.account.searchMessages
        .query({ scope: 'all', keyword: searchQuery, limit: 5 })
        .then((hits) => {
          if (searchRunRef.current !== run) return; // a newer keystroke superseded us
          setSearchHits(hits as MsgSearchHitWire[]);
          setSearchOpen(true);
          setSearchLoading(false);
        })
        .catch((err) => {
          if (searchRunRef.current !== run) return;
          console.error('[search] searchMessages failed', err);
          setSearchHits([]);
          setSearchLoading(false);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  // After hits land, batch-resolve group senders' nicknames from profile_info.db
  // (one extra query). Only the uids we don't already have a name for.
  useEffect(() => {
    const unknown = searchHits
      .filter((hit) => isGroupChatType(hit.chatType) && hit.senderUid)
      .map((hit) => hit.senderUid)
      .filter((uid) => !profileByUid.has(uid) && !searchNicks[uid]);
    const todo = [...new Set(unknown)];
    if (todo.length === 0) return;

    let cancelled = false;
    client.account.getNicksByUids
      .query({ uids: todo })
      .then((map) => {
        if (cancelled) return;
        const resolved = map as Record<string, string>;
        if (Object.keys(resolved).length > 0) {
          setSearchNicks((prev) => ({ ...prev, ...resolved }));
        }
      })
      .catch((err) => console.error('[search] getNicksByUids failed', err));
    return () => {
      cancelled = true;
    };
  }, [searchHits, profileByUid, searchNicks]);

  // Click a search hit → switch to its conversation and jump to the message.
  const openSearchHit = useCallback(
    (hit: MsgSearchHitWire): void => {
      const kind: 'group' | 'c2c' = isGroupChatType(hit.chatType) ? 'group' : 'c2c';
      const conv = hit.targetUid;
      setSearchOpen(false);
      shell.setQuery('');
      if (!hit.msgSeq) {
        // No seq (shouldn't happen now FTS returns 40003) — just open the chat.
        console.warn('[search] hit missing msgSeq, opening conversation only');
        shell.selectConversation(conv);
        return;
      }
      if (selectionRef.current?.id === conv) {
        // Already open — jump straight away.
        void centerWindowOnSeq(conv, kind, hit.msgSeq);
        return;
      }
      // Switch conversations; the listLatest effect performs the centred jump
      // once the placeholder newest page lands.
      pendingSearchJumpRef.current = { conv, kind, seq: hit.msgSeq };
      shell.selectConversation(conv);
    },
    [centerWindowOnSeq, shell],
  );

  // Resolve display fields (conversation name/avatar, sender name) for each hit
  // from already-loaded maps; fall back to ids when unresolved.
  const searchResultRows = useMemo(() => {
    return searchHits.map((hit) => {
      const isGroup = isGroupChatType(hit.chatType);
      const conversation = groupsById.get(hit.targetUid);
      const convName = isGroup
        ? conversation?.group?.name || hit.targetUid
        : conversation?.otherUser?.displayName || conversation?.group?.name || hit.targetUid;
      const avatarUrl = isGroup
        ? conversation?.group?.avatarUrl || groupAvatarSrc(hit.targetUid)
        : conversation?.otherUser?.avatarUrl || null;
      // Sender name: prefer loaded buddy profile, then the nickname resolved
      // from profile_info.db, finally a short uid. (c2c sender == the peer.)
      const senderProfile = profileByUid.get(hit.senderUid);
      const senderName = isGroup
        ? displayProfileName(senderProfile) ||
          searchNicks[hit.senderUid] ||
          `${hit.senderUid.slice(0, 8)}…`
        : convName;
      return {
        hit,
        convName,
        avatarUrl,
        senderName,
        time: searchHitTime(hit.sendTime),
        runs: highlightSnippet(hit.content, searchQuery),
      };
    });
  }, [searchHits, groupsById, profileByUid, searchNicks, searchQuery]);

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
        void refreshWindow();
      },
      onError(err) {
        console.error('[live] onDbChanged subscription error', err);
      },
    });
    return () => sub.unsubscribe();
  }, [utils, refreshWindow]);

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
      if (
        scrollElement.scrollTop <= 32 ||
        scrollElement.scrollHeight <= scrollElement.clientHeight + 32
      ) {
        requestOlderMessages(scrollElement);
      }
      if (
        scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight <= 32
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

    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        scroll.scrollTop = Math.max(0, scroll.scrollHeight - restore.previousHeight + restore.previousTop);
        pendingScrollRestoreRef.current = null;
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [selectedConversation?.id, templateMessages.length]);

  useEffect(() => {
    if (!templateCreditOpen) return undefined;

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setTemplateCreditOpen(false);
    }

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [templateCreditOpen]);

  useEffect(() => {
    if (!searchOpen) return undefined;
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setSearchOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [searchOpen]);

  async function closeAccount(): Promise<void> {
    await client.bootstrap.closeAccount.mutate();
    setOpenedUin(null);
    goTo('bootstrap');
  }

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

  return (
    <ReplyJumpContext.Provider value={jumpToSeq}>
      <ChatShell
        user={user}
        view={shell.view}
        query={shell.query}
        contactTab={shell.contactTab}
        activeNotice={shell.contactNotice}
        sidebarWidth={shell.sidebarWidth}
        mainOpen={shell.mainOpen}
        messageBadgeCount={0}
        contactBadgeCount={0}
        showTools={false}
        railFooterContent={
          <button className="weq-rail-signout" type="button" title="Sign out" onClick={() => void closeAccount()}>
            <LogOut size={22} />
          </button>
        }
        friendNoticeCount={contactRequests.length}
        groupNoticeCount={groupRequests.length}
        onViewChange={shell.switchView}
        onOpenSettings={noopAsync}
        onOpenProfile={noopAsync}
        onOpenAbout={noopAsync}
        onOpenHelp={() => setTemplateCreditOpen(true)}
        onOpenInvite={noopAsync}
        onQueryChange={shell.setQuery}
        onQuickInvite={noopAsync}
        onCreateGroup={noopAsync}
        onOpenFriendNotices={() => shell.openContactNotice('friend')}
        onOpenGroupNotices={() => shell.openContactNotice('group')}
        onContactTabChange={shell.changeContactTab}
        onSidebarWidthChange={shell.updateSidebarWidth}
        sidebarContent={
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
              onSelectConversation={shell.selectConversation}
              onSelectContact={shell.selectContact}
              onSelectGroup={shell.selectGroup}
              activateToolsOnSelect={false}
            />
            {searchOpen && searchQuery ? (
              <div className="weq-search-dropdown" role="listbox">
                {searchLoading && searchResultRows.length === 0 ? (
                  <div className="weq-search-empty">搜索中…</div>
                ) : searchResultRows.length === 0 ? (
                  <div className="weq-search-empty">没有找到相关消息</div>
                ) : (
                  searchResultRows.map((row) => (
                    <button
                      key={`${row.hit.targetUid}:${row.hit.msgId}`}
                      type="button"
                      className="weq-search-row"
                      role="option"
                      onClick={() => openSearchHit(row.hit)}
                    >
                      <span className="weq-search-avatar">
                        {row.avatarUrl ? (
                          <img src={row.avatarUrl} alt="" loading="lazy" />
                        ) : (
                          <span className="weq-search-avatar-fallback">
                            {row.convName.slice(0, 1)}
                          </span>
                        )}
                      </span>
                      <span className="weq-search-text">
                        <span className="weq-search-row-top">
                          <span className="weq-search-name">{row.convName}</span>
                          <span className="weq-search-time">{row.time}</span>
                        </span>
                        <span className="weq-search-snippet">
                          <span className="weq-search-sender">{row.senderName}: </span>
                          {row.runs.map((part, i) =>
                            part.hit ? (
                              <mark key={i} className="weq-search-hl">
                                {part.text}
                              </mark>
                            ) : (
                              <span key={i}>{part.text}</span>
                            ),
                          )}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
            <OverlayScrollbar
              targetSelector=".app-shell .sidebar-body"
              className="weq-sidebar-scrollbar"
              refreshKey={`sidebar:${shell.view}:${conversations.length}:${buddyContacts.length}:${shell.query}`}
            />
          </>
        }
        mainContent={
          <div className="weq-template-main-wrap">
            <div className="weq-readonly-chat">
              <ChatMainContent
                user={user}
                view={shell.view}
                contactNotice={shell.contactNotice}
                contactRequests={contactRequests}
                groupRequests={groupRequests}
                selectedContact={shell.selectedContact}
                selectedGroupConversation={shell.selectedGroupConversation}
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
                onUpdateGroup={async (_conversationId: string, _input: GroupUpdateInput) => undefined}
                onLoadMoreGroupMembers={requestMoreGroupMembers}
                groupMembersLoading={selectedGroupMembersLoading}
                onOpenNotificationSettings={noopAsync}
                onSend={noopAsync}
                onDraftChange={updateDraft}
                onDraftClear={(_conversationId) => updateDraft(_conversationId, '')}
                onBackConversation={shell.backConversation}
              />
            </div>
            <OverlayScrollbar
              targetSelector=".weq-readonly-chat .message-scroll"
              className="weq-message-scrollbar"
              refreshKey={`messages:${selectedConversation?.id ?? 'none'}:${templateMessages.length}`}
            />
            <OverlayScrollbar
              targetSelector=".weq-readonly-chat .group-info-member-list"
              className="weq-group-members-scrollbar"
              refreshKey={`group-members:${selectedConversation?.id ?? 'none'}:${currentGroupMembers.length}`}
            />
          </div>
        }
      />
      {templateCreditOpen ? (
        <div className="weq-template-credit-layer" role="presentation" onMouseDown={() => setTemplateCreditOpen(false)}>
          <section
            className="weq-template-credit-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="weq-template-credit-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="weq-template-credit-close"
              type="button"
              title="Close"
              aria-label="Close"
              onClick={() => setTemplateCreditOpen(false)}
            >
              <X size={18} />
            </button>
            <h2 id="weq-template-credit-title">消息列表说明</h2>
            <p>
              当前消息列表基于{' '}
              <a href="https://github.com/dogxii/webark-im-template" target="_blank" rel="noreferrer">
                dogxii/webark-im-template
              </a>{' '}
              项目进行适配与修改。
            </p>
            <p>感谢 dogxii 及原项目贡献者提供的优秀 IM 模板基础。</p>
          </section>
        </div>
      ) : null}
    </ReplyJumpContext.Provider>
  );
}
