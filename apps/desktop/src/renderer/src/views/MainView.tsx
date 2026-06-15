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
import { LogOut, RefreshCw, X } from 'lucide-react';
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
import { qqFaceMessageRenderer } from '../components/QqMessageContent';

const messageRenderers: MessageRenderer[] = composeMessageRenderers({
  prepend: [qqFaceMessageRenderer],
});

const PAGE_SIZE = 50;

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
  senderUid: string;
  senderUin: string;
  sendTime: string;
  elements: unknown[];
};

type RenderElementWire = {
  type?: string;
  data?: Record<string, unknown>;
};

type MessagePages = Record<number, MessageWire[]>;

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
const emptyContacts: Contact[] = [];

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

function chatTypeKind(chatType: string | number): 'direct' | 'group' | null {
  const s = String(chatType);
  if (s.includes('C2C')) return 'direct';
  if (s.includes('GROUP')) return 'group';
  return null;
}

function toIsoTime(seconds: string | undefined): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return new Date(0).toISOString();
  return new Date(value * 1000).toISOString();
}

function contactTitle(c: RecentContactWire): string {
  return c.targetDisplayName || c.targetRemark || c.senderDisplayName || c.senderNick || c.targetUid;
}

function previewText(preview: unknown): string | null {
  if (!preview || typeof preview !== 'object') return null;
  const value = (preview as { displayText?: unknown }).displayText;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function currentUser(openedUin: string | null): User {
  const identityValue = openedUin ?? 'unknown';
  return {
    id: `self:${identityValue}`,
    identityLabel: 'UIN',
    identityValue,
    username: `uin-${identityValue}`,
    displayName: 'WeQ',
    avatarUrl: senderAvatarSrc(identityValue),
  };
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

function messageSender(message: MessageWire, conversation: Conversation, user: User): User {
  if (isMineMessage(message, user)) return user;
  if (conversation.type === 'direct') return conversation.otherUser;

  return {
    id: message.senderUid || `sender:${message.senderUin}`,
    identityLabel: message.senderUin && message.senderUin !== '0' ? 'QQ' : 'UID',
    identityValue: message.senderUin && message.senderUin !== '0' ? message.senderUin : message.senderUid,
    username: message.senderUid || message.senderUin,
    displayName: message.senderUin && message.senderUin !== '0' ? message.senderUin : 'Member',
    avatarUrl: senderAvatarSrc(message.senderUin),
  };
}

function messageToTemplate(message: MessageWire, conversation: Conversation, user: User): Message {
  const sender = messageSender(message, conversation, user);
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

function enrichGroupConversation(conversation: Conversation | undefined, messages: Message[], user: User): Conversation | undefined {
  if (!conversation || conversation.type !== 'group') return conversation;

  const members = new Map<string, GroupMember>();
  members.set(user.id, { ...user, role: 'member', joinedAt: conversation.updatedAt });
  for (const message of messages) {
    if (!message.sender || message.sender.id === user.id) continue;
    members.set(message.sender.id, {
      ...message.sender,
      role: 'member',
      joinedAt: message.createdAt,
    });
  }

  return {
    ...conversation,
    members: Array.from(members.values()),
    group: {
      ...conversation.group,
      memberCount: Math.max(conversation.group.memberCount, members.size),
    },
  };
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
  const openedUin = useViewState((s) => s.openedUin);
  const goTo = useViewState((s) => s.goTo);
  const setOpenedUin = useViewState((s) => s.setOpenedUin);
  const [offset, setOffset] = useState(0);
  const [messagePages, setMessagePages] = useState<MessagePages>({});
  const [hasOlderMessages, setHasOlderMessages] = useState(true);
  const [conversationPrefs, setConversationPrefs] = useState<ConversationPreferences>({});
  const [templateCreditOpen, setTemplateCreditOpen] = useState(false);
  const pendingOlderOffsetRef = useRef<number | null>(null);
  const pendingScrollRestoreRef = useRef<PendingScrollRestore | null>(null);

  const user = useMemo(() => currentUser(openedUin), [openedUin]);
  const conversations = useMemo(
    () =>
      ((contacts.data ?? []) as RecentContactWire[])
        .map((contact) => contactToConversation(contact, user))
        .filter((conversation): conversation is Conversation => conversation !== null),
    [contacts.data, user],
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
    contacts: emptyContacts,
    conversationPrefs,
    initialActiveConversationId: null,
    sidebarWidthStorageKey: 'weq.desktop.sidebarWidth.v2',
    history: shellHistory,
  });

  const selectedConversation = shell.activeConversation;
  const selectedUid = selectedConversation?.id ?? '';
  const isGroup = selectedConversation?.type === 'group';
  const isDirect = selectedConversation?.type === 'direct';
  const c2cMsgs = trpc.account.listC2cMessages.useQuery(
    { targetUid: selectedUid, limit: PAGE_SIZE, offset },
    { enabled: Boolean(selectedUid && isDirect) },
  );
  const groupMsgs = trpc.account.listGroupMessages.useQuery(
    { targetGroupCode: selectedUid, limit: PAGE_SIZE, offset },
    { enabled: Boolean(selectedUid && isGroup) },
  );
  const messagesQuery = isGroup ? groupMsgs : c2cMsgs;
  const loadedMessageWires = useMemo(() => {
    const seen = new Set<string>();
    const sortedOffsets = Object.keys(messagePages)
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => b - a);
    const messages: MessageWire[] = [];

    for (const pageOffset of sortedOffsets) {
      const page = messagePages[pageOffset] ?? [];
      for (let index = page.length - 1; index >= 0; index -= 1) {
        const message = page[index];
        if (!message || seen.has(message.msgId)) continue;
        seen.add(message.msgId);
        messages.push(message);
      }
    }

    return messages;
  }, [messagePages]);
  const templateMessages = useMemo(() => {
    if (!selectedConversation) return [];
    return loadedMessageWires.map((message) => messageToTemplate(message, selectedConversation, user));
  }, [loadedMessageWires, selectedConversation, user]);
  const activeConversation = useMemo(
    () => enrichGroupConversation(selectedConversation, templateMessages, user),
    [selectedConversation, templateMessages, user],
  );
  const refreshing = contacts.isFetching || messagesQuery.isFetching;
  const loadingInitialMessages = messagesQuery.isLoading && loadedMessageWires.length === 0;
  const maxLoadedOffset = useMemo(
    () =>
      Object.keys(messagePages)
        .map(Number)
        .filter(Number.isFinite)
        .reduce((max, value) => Math.max(max, value), 0),
    [messagePages],
  );

  useEffect(() => {
    if (contacts.isLoading) return;
    if (shell.activeConversationId && conversations.some((conversation) => conversation.id === shell.activeConversationId)) return;
    shell.setActiveConversationId(conversations[0]?.id ?? null);
    setOffset(0);
  }, [contacts.isLoading, conversations, shell.activeConversationId, shell.setActiveConversationId]);

  useEffect(() => {
    setOffset(0);
    setMessagePages({});
    setHasOlderMessages(true);
    pendingOlderOffsetRef.current = null;
    pendingScrollRestoreRef.current = null;
  }, [shell.activeConversationId]);

  useEffect(() => {
    if (!selectedConversation || !messagesQuery.data) return;

    const page = messagesQuery.data as MessageWire[];
    setMessagePages((current) => ({
      ...current,
      [offset]: page,
    }));
    setHasOlderMessages(page.length >= PAGE_SIZE);

    if (pendingOlderOffsetRef.current === offset) {
      pendingOlderOffsetRef.current = null;
    }
  }, [messagesQuery.data, offset, selectedConversation]);

  const requestOlderMessages = useCallback(
    (scroll: HTMLElement): void => {
      if (!selectedConversation || !hasOlderMessages || messagesQuery.isFetching) return;
      if (pendingOlderOffsetRef.current !== null) return;
      if (pendingScrollRestoreRef.current !== null) return;

      const nextOffset = maxLoadedOffset + PAGE_SIZE;
      if (messagePages[nextOffset]) return;

      pendingOlderOffsetRef.current = nextOffset;
      pendingScrollRestoreRef.current = {
        conversationId: selectedConversation.id,
        previousHeight: scroll.scrollHeight,
        previousTop: scroll.scrollTop,
      };
      setOffset(nextOffset);
    },
    [hasOlderMessages, maxLoadedOffset, messagePages, messagesQuery.isFetching, selectedConversation],
  );

  useEffect(() => {
    if (!selectedConversation) return undefined;

    const scroll = document.querySelector<HTMLElement>('.weq-readonly-chat .message-scroll');
    if (!scroll) return undefined;
    const scrollElement = scroll;

    function maybeLoadOlder(): void {
      if (
        scrollElement.scrollTop <= 32 ||
        scrollElement.scrollHeight <= scrollElement.clientHeight + 32
      ) {
        requestOlderMessages(scrollElement);
      }
    }

    scrollElement.addEventListener('scroll', maybeLoadOlder, { passive: true });
    const frame = window.requestAnimationFrame(maybeLoadOlder);

    return () => {
      scrollElement.removeEventListener('scroll', maybeLoadOlder);
      window.cancelAnimationFrame(frame);
    };
  }, [requestOlderMessages, selectedConversation, templateMessages.length]);

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

  async function closeAccount(): Promise<void> {
    await client.bootstrap.closeAccount.mutate();
    setOpenedUin(null);
    goTo('bootstrap');
  }

  function refreshAll(): void {
    setOffset(0);
    setMessagePages({});
    setHasOlderMessages(true);
    pendingOlderOffsetRef.current = null;
    pendingScrollRestoreRef.current = null;
    void utils.invalidate();
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
    <>
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
        friendNoticeCount={0}
        groupNoticeCount={0}
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
              contacts={emptyContacts}
              query={shell.query}
              onSelectConversation={shell.selectConversation}
              onSelectContact={shell.selectContact}
              onSelectGroup={shell.selectGroup}
              activateToolsOnSelect={false}
            />
            <OverlayScrollbar
              targetSelector=".app-shell .sidebar-body"
              className="weq-sidebar-scrollbar"
              refreshKey={`sidebar:${shell.view}:${conversations.length}:${shell.query}`}
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
                contactRequests={[]}
                groupRequests={[]}
                selectedContact={shell.selectedContact}
                selectedGroupConversation={shell.selectedGroupConversation}
                activeConversation={activeConversation}
                messages={templateMessages}
                messageRenderers={messageRenderers}
                loadingMessages={loadingInitialMessages}
                conversationPrefs={conversationPrefs}
                drafts={emptyDrafts}
                contacts={emptyContacts}
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
                onInviteGroupMembers={async () => undefined}
                onOpenNotificationSettings={noopAsync}
                onSend={noopAsync}
                onDraftChange={updateDraft}
                onDraftClear={(_conversationId) => updateDraft(_conversationId, '')}
                onBackConversation={shell.backConversation}
              />
            </div>
            <div className="weq-chat-action-bar">
              <button type="button" title="Refresh" disabled={refreshing} onClick={refreshAll}>
                <RefreshCw size={17} className={refreshing ? 'weq-spin' : undefined} />
              </button>
            </div>
            <OverlayScrollbar
              targetSelector=".weq-readonly-chat .message-scroll"
              className="weq-message-scrollbar"
              refreshKey={`messages:${selectedConversation?.id ?? 'none'}:${templateMessages.length}`}
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
    </>
  );
}
