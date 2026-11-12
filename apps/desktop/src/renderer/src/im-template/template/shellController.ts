// @ts-nocheck
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SIDEBAR_WIDTH, loadLayoutNumber, saveLayoutNumber } from './layoutStorage';
import { defaultConversationPreference } from './preferences';
import { usePageSnapshotKey, usePageState } from '../../components/PageSnapshots';
import { pageSnapshots, pageValue } from '../../lib/pageSnapshots';
import {
  isMobileNavigation,
  mobileBack,
  pushMobileBack,
  resetMobileRoot,
} from '../../hooks/useMobileNavigation';
import { z } from 'zod';
import { contactWorkspaceTabSchema, type ContactWorkspaceTab } from '../../lib/profileNavigation';
import type {
  Contact,
  ContactNoticeView,
  ContactTab,
  Conversation,
  ConversationPreferences,
  MainView,
} from './types';

type GroupConversation = Extract<Conversation, { type: 'group' }>;

type ShellSelectionState = {
  activeConversationId: string | null;
  contactNotice: ContactNoticeView | null;
  selectedContactId: string | null;
  selectedGroupConversationId: string | null;
  view: MainView;
};

export type ChatShellHistoryAdapter = {
  isMobileShell: () => boolean;
  shouldAutoSelectConversation: () => boolean;
  replaceShell: () => void;
  pushShellDetail: () => void;
  pushConversationDetail: (conversationId: string) => void;
};

export const noopChatShellHistoryAdapter: ChatShellHistoryAdapter = {
  isMobileShell: () => false,
  shouldAutoSelectConversation: () => true,
  replaceShell: () => undefined,
  pushShellDetail: () => undefined,
  pushConversationDetail: () => undefined,
};

export type UseChatShellControllerOptions = {
  conversations: Conversation[];
  contacts: Contact[];
  conversationPrefs: ConversationPreferences;
  initialActiveConversationId: string | null;
  initialView?: MainView;
  startupView?: 'home' | 'messages' | null;
  sidebarWidthStorageKey: string;
  history: ChatShellHistoryAdapter;
  onReadConversation?: (conversationId: string) => void;
  onOpenContactNotice?: (kind: ContactNoticeView) => void;
};

export function useChatShellController({
  conversations,
  contacts,
  conversationPrefs,
  initialActiveConversationId,
  initialView = 'messages',
  startupView = null,
  sidebarWidthStorageKey,
  history: historyAdapter,
  onReadConversation,
  onOpenContactNotice,
}: UseChatShellControllerOptions) {
  /**
   * 启动栏目直接作为 `shell:view` 的初始值：首帧就落在指定栏目，不先渲染一次
   * `initialView` 再用 effect 纠正（那会闪一下消息页，也让首帧现场是错的）。
   * 之后 `startupView` 变化不再应用 —— 用户已经切走的页面不能被启动页抢回来。
   */
  const [view, setView] = usePageState<MainView>(
    'shell:view',
    startupView ?? initialView,
    z.enum([
      'home',
      'messages',
      'contacts',
      'more',
      'collections',
      'guild-direct',
      'export',
      'agentlab',
      'cache',
      'tools',
      'qzone',
      'mail',
      'channel',
      'annual',
    ]),
  );
  const viewSnapshotKey = usePageSnapshotKey('shell:view');
  const startupRecorded = useRef(false);
  useLayoutEffect(() => {
    if (!startupView || startupRecorded.current || !viewSnapshotKey) return;
    startupRecorded.current = true;
    // 首帧已经落在 startupView；再把它登记成"当前现场"，崩溃后冷启动才回得到这一栏。
    // 只写存储、不动 React 状态 —— 不能靠 effect 事后切页，那会让首帧是错的。
    try {
      pageSnapshots.write(viewSnapshotKey, startupView);
    } catch {
      /* 现场写不进去不影响本次启动 */
    }
  }, [startupView, viewSnapshotKey]);
  const [query, setQuery] = usePageState('shell:query', '', pageValue.string);
  const [contactTab, setContactTab] = usePageState<ContactTab>(
    'shell:contact-tab',
    'friends',
    z.enum(['friends', 'groups']),
  );
  const [contactNotice, setContactNotice] = usePageState<ContactNoticeView | null>(
    'shell:notice',
    null,
    z.enum(['friend', 'group']).nullable(),
  );
  const [contactOverviewOpen, setContactOverviewOpen] = usePageState(
    'shell:contact-overview',
    true,
    pageValue.boolean,
  );
  const [selectedContactId, setSelectedContactId] = usePageState<string | null>(
    'shell:contact',
    null,
    pageValue.optionalString,
  );
  const [expandedContact, setExpandedContact] = useState<Contact | undefined>();
  const [expandedGroup, setExpandedGroup] = useState<GroupConversation | undefined>();
  const [contactWorkspaceTab, setContactWorkspaceTab] = usePageState<ContactWorkspaceTab>(
    'shell:contact-detail',
    'profile',
    contactWorkspaceTabSchema,
  );
  const [selectedGroupConversationId, setSelectedGroupConversationId] = usePageState<string | null>(
    'shell:group',
    null,
    pageValue.optionalString,
  );
  const [activeConversationId, setActiveConversationId] = usePageState<string | null>(
    'shell:conversation',
    initialActiveConversationId,
    pageValue.optionalString,
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    loadLayoutNumber(sidebarWidthStorageKey, DEFAULT_SIDEBAR_WIDTH, 220, 520),
  );
  const backStateRef = useRef<ShellSelectionState>({
    activeConversationId,
    contactNotice,
    selectedContactId,
    selectedGroupConversationId,
    view,
  });
  const onReadConversationRef = useRef(onReadConversation);
  const restoreRef = useRef<() => () => void>(() => () => {});
  // 连续查看不同资料时保留最初的外部来源，主动切栏目或选目录对象后清除。
  const profileReturn = useRef<(() => void) | null>(null);
  restoreRef.current = () => {
    const snapshot = {
      activeConversationId,
      contactNotice,
      selectedContactId,
      selectedGroupConversationId,
      view,
      contactTab,
      contactWorkspaceTab,
      contactOverviewOpen,
      query,
    };
    return () => {
      setView(snapshot.view);
      setActiveConversationId(snapshot.activeConversationId);
      setContactNotice(snapshot.contactNotice);
      setSelectedContactId(snapshot.selectedContactId);
      setSelectedGroupConversationId(snapshot.selectedGroupConversationId);
      setContactTab(snapshot.contactTab);
      setContactWorkspaceTab(snapshot.contactWorkspaceTab);
      setContactOverviewOpen(snapshot.contactOverviewOpen);
      setQuery(snapshot.query);
    };
  };
  const history = useMemo(() => {
    const push = () => {
      if (!isMobileNavigation()) return;
      const restore = restoreRef.current();
      pushMobileBack(restore, () =>
        document.querySelector<HTMLElement>('.weq-web-shell .chat-main'),
      );
    };
    return {
      ...historyAdapter,
      replaceShell: () =>
        isMobileNavigation() ? resetMobileRoot() : historyAdapter.replaceShell(),
      pushShellDetail: () => (isMobileNavigation() ? push() : historyAdapter.pushShellDetail()),
      pushConversationDetail: (id: string) =>
        isMobileNavigation() ? push() : historyAdapter.pushConversationDetail(id),
    };
  }, [historyAdapter]);

  useEffect(() => {
    onReadConversationRef.current = onReadConversation;
  }, [onReadConversation]);

  useEffect(() => {
    backStateRef.current = {
      activeConversationId,
      contactNotice,
      selectedContactId,
      selectedGroupConversationId,
      view,
    };
  }, [activeConversationId, contactNotice, selectedContactId, selectedGroupConversationId, view]);

  useEffect(() => {
    if (activeConversationId) {
      onReadConversationRef.current?.(activeConversationId);
    }
  }, [activeConversationId]);

  useEffect(() => {
    if (isMobileNavigation()) return;
    function clearMobileDetailState(nextView: 'messages' | 'contacts') {
      backStateRef.current = { ...backStateRef.current, view: nextView };
      setView(nextView);
      if (nextView === 'messages') {
        backStateRef.current.activeConversationId = null;
        setActiveConversationId(null);
      } else {
        backStateRef.current.contactNotice = null;
        backStateRef.current.selectedContactId = null;
        backStateRef.current.selectedGroupConversationId = null;
        setSelectedContactId(null);
        setSelectedGroupConversationId(null);
        setContactNotice(null);
        setContactOverviewOpen(false);
      }
    }

    function returnToParentPage() {
      if (!history.isMobileShell()) {
        return;
      }

      const current = backStateRef.current;
      if (current.view === 'messages' && current.activeConversationId) {
        clearMobileDetailState('messages');
        window.setTimeout(() => clearMobileDetailState('messages'), 0);
        history.replaceShell();
        return;
      }

      if (
        current.view === 'contacts' &&
        (current.contactNotice || current.selectedContactId || current.selectedGroupConversationId)
      ) {
        clearMobileDetailState('contacts');
        window.setTimeout(() => clearMobileDetailState('contacts'), 0);
        history.replaceShell();
      }
    }

    window.addEventListener('popstate', returnToParentPage);
    return () => window.removeEventListener('popstate', returnToParentPage);
  }, [
    history,
    setSelectedContactId,
    setSelectedGroupConversationId,
    setActiveConversationId,
    setContactOverviewOpen,
    setView,
    setContactNotice,
  ]);

  const listedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId),
    [activeConversationId, conversations],
  );
  // 目录刷新不等于关闭会话；保留最近打开的资料，返回重进也无需等待目录。
  const openedConversation = useRef<Conversation | undefined>(undefined);
  const activeConversation =
    listedConversation ??
    (openedConversation.current?.id === activeConversationId
      ? openedConversation.current
      : undefined);
  useLayoutEffect(() => {
    if (activeConversation) openedConversation.current = activeConversation;
  }, [activeConversation]);
  const selectedContact = useMemo(() => {
    if (contactTab !== 'friends') return undefined;
    const local = contacts.find((contact) => contact.id === selectedContactId);
    const expanded = expandedContact?.id === selectedContactId ? expandedContact : undefined;
    return local && expanded
      ? {
          ...expanded,
          ...local,
          profileContext: expanded.profileContext,
        }
      : (local ?? expanded);
  }, [contacts, selectedContactId, expandedContact, contactTab]);
  const selectedGroupConversation = useMemo(
    () =>
      contactTab === 'groups'
        ? (conversations.find(
            (conversation): conversation is GroupConversation =>
              conversation.type === 'group' && conversation.id === selectedGroupConversationId,
          ) ?? (expandedGroup?.id === selectedGroupConversationId ? expandedGroup : undefined))
        : undefined,
    [conversations, selectedGroupConversationId, expandedGroup, contactTab],
  );
  const messageUnreadCount = useMemo(
    () => countVisibleUnreadConversations(conversations, conversationPrefs),
    [conversations, conversationPrefs],
  );
  const mainOpen =
    view === 'messages'
      ? Boolean(activeConversation)
      : view === 'contacts'
        ? Boolean(selectedContact || selectedGroupConversation || contactNotice)
        : false;

  const switchView = useCallback(
    (nextView: MainView) => {
      profileReturn.current = null;
      setView(nextView);
      history.replaceShell();
      if (isMobileNavigation()) {
        setActiveConversationId(null);
        setSelectedContactId(null);
        setSelectedGroupConversationId(null);
        setContactNotice(null);
      }
      if (nextView === 'messages' && !history.isMobileShell())
        setActiveConversationId(
          (current) =>
            current ??
            (history.shouldAutoSelectConversation() ? (conversations[0]?.id ?? null) : null),
        );
    },
    [
      conversations,
      history,
      setActiveConversationId,
      setView,
      setContactNotice,
      setSelectedContactId,
      setSelectedGroupConversationId,
    ],
  );

  const changeContactTab = useCallback(
    (tab: ContactTab) => {
      setContactTab(tab);
      setContactNotice(null);
      setContactOverviewOpen(false);
    },
    [setContactTab, setContactOverviewOpen, setContactNotice],
  );

  const openContactNotice = useCallback(
    (kind: ContactNoticeView) => {
      profileReturn.current = null;
      history.pushShellDetail();
      backStateRef.current = {
        ...backStateRef.current,
        contactNotice: kind,
        selectedContactId: null,
        selectedGroupConversationId: null,
        view: 'contacts',
      };
      setView('contacts');
      setContactNotice(kind);
      setContactOverviewOpen(false);
      setSelectedContactId(null);
      setSelectedGroupConversationId(null);
      onOpenContactNotice?.(kind);
    },
    [
      history,
      onOpenContactNotice,
      setSelectedContactId,
      setSelectedGroupConversationId,
      setContactOverviewOpen,
      setView,
      setContactNotice,
    ],
  );

  const selectConversation = useCallback(
    (conversationId: string) => {
      profileReturn.current = null;
      history.pushConversationDetail(conversationId);
      setView('messages');
      setActiveConversationId(conversationId);
    },
    [history, setActiveConversationId, setView],
  );

  const selectContact = useCallback(
    (contact: Contact) => {
      profileReturn.current = null;
      history.pushShellDetail();
      setContactNotice(null);
      setContactOverviewOpen(false);
      setSelectedContactId(contact.id);
      setContactWorkspaceTab('profile');
    },
    [
      history,
      setContactWorkspaceTab,
      setSelectedContactId,
      setContactOverviewOpen,
      setContactNotice,
    ],
  );

  const selectGroup = useCallback(
    (conversationId: string) => {
      profileReturn.current = null;
      history.pushShellDetail();
      setContactNotice(null);
      setContactOverviewOpen(false);
      setSelectedGroupConversationId(conversationId);
    },
    [history, setSelectedGroupConversationId, setContactOverviewOpen, setContactNotice],
  );

  const openContactDetails = useCallback(
    (contact: Contact, tab: ContactWorkspaceTab = 'profile') => {
      if (view !== 'contacts') profileReturn.current = restoreRef.current();
      history.pushShellDetail();
      setView('contacts');
      setContactTab('friends');
      setContactNotice(null);
      setContactOverviewOpen(false);
      setQuery('');
      setExpandedContact(contact);
      setSelectedContactId(contact.id);
      setContactWorkspaceTab(tab);
    },
    [
      view,
      history,
      setContactTab,
      setContactWorkspaceTab,
      setQuery,
      setSelectedContactId,
      setContactOverviewOpen,
      setView,
      setContactNotice,
    ],
  );

  const openGroupDetails = useCallback(
    (conversation: GroupConversation) => {
      if (view !== 'contacts') profileReturn.current = restoreRef.current();
      history.pushShellDetail();
      setView('contacts');
      setContactTab('groups');
      setContactNotice(null);
      setContactOverviewOpen(false);
      setQuery('');
      setExpandedGroup(conversation);
      setSelectedGroupConversationId(conversation.id);
    },
    [
      view,
      history,
      setSelectedGroupConversationId,
      setQuery,
      setContactTab,
      setContactOverviewOpen,
      setView,
      setContactNotice,
    ],
  );

  const openConversation = useCallback(
    (conversationId: string | null) => {
      profileReturn.current = null;
      if (conversationId) {
        history.pushConversationDetail(conversationId);
      }
      setView('messages');
      setActiveConversationId(conversationId);
    },
    [history, setActiveConversationId, setView],
  );

  const updateSidebarWidth = useCallback(
    (width: number) => {
      setSidebarWidth(width);
      saveLayoutNumber(sidebarWidthStorageKey, width);
    },
    [sidebarWidthStorageKey],
  );

  const backContact = useCallback(() => {
    const restore = profileReturn.current;
    profileReturn.current = null;
    setSelectedContactId(null);
    setSelectedGroupConversationId(null);
    setContactNotice(null);
    setContactOverviewOpen(true);
    restore?.();
    history.replaceShell();
  }, [
    history,
    setSelectedContactId,
    setSelectedGroupConversationId,
    setContactNotice,
    setContactOverviewOpen,
  ]);

  const backGroup = backContact;

  const backContactNotice = useCallback(() => {
    if (mobileBack()) return;
    setContactNotice(null);
    history.replaceShell();
  }, [history, setContactNotice]);

  const backConversation = useCallback(() => {
    if (mobileBack()) return;
    setActiveConversationId(null);
    history.replaceShell();
  }, [history, setActiveConversationId]);

  return {
    activeConversation,
    activeConversationId,
    backContact,
    backContactNotice,
    backConversation,
    backGroup,
    changeContactTab,
    contactNotice,
    // 空标签或已失效的详情选择回落到群交集首页，不再要求额外点击占位入口。
    contactOverviewOpen:
      contactOverviewOpen || (!selectedContact && !selectedGroupConversation && !contactNotice),
    contactTab,
    contactWorkspaceTab,
    setContactWorkspaceTab,
    mainOpen,
    messageUnreadCount,
    openContactNotice,
    openConversation,
    openContactDetails,
    openGroupDetails,
    profileReturnPending: view === 'contacts' && profileReturn.current !== null,
    query,
    selectContact,
    selectConversation,
    selectGroup,
    selectedContact,
    selectedContactId,
    selectedGroupConversation,
    selectedGroupConversationId,
    setActiveConversationId,
    setQuery,
    sidebarWidth,
    switchView,
    updateSidebarWidth,
    view,
  };
}

export function countVisibleUnreadConversations(
  conversations: Conversation[],
  conversationPrefs: ConversationPreferences,
) {
  return conversations.reduce((total, conversation) => {
    const preference = {
      ...defaultConversationPreference,
      ...conversation.preference,
      ...conversationPrefs[conversation.id],
    };
    return preference.muted ? total : total + (conversation.unreadCount ?? 0);
  }, 0);
}
