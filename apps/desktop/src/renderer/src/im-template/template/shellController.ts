// @ts-nocheck
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { loadLayoutNumber, saveLayoutNumber } from './layoutStorage';
import { defaultConversationPreference } from './preferences';
import { usePageState } from '../../components/PageSnapshots';
import { pageValue } from '../../lib/pageSnapshots';
import { z } from 'zod';
import type { ContactWorkspaceTab } from '../../lib/profileNavigation';
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
  history,
  onReadConversation,
  onOpenContactNotice,
}: UseChatShellControllerOptions) {
  const [view, setView] = usePageState<MainView>(
    'shell:view',
    initialView,
    z.enum([
      'home',
      'messages',
      'contacts',
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
  const [query, setQuery] = usePageState('shell:query', '', pageValue.string);
  const startupApplied = useRef(false);
  useLayoutEffect(() => {
    if (startupApplied.current) return;
    startupApplied.current = true;
    // 正常启动的旧页面现场已在工作区挂载前重置，此处指定初始栏目。
    if (startupView) setView(startupView);
  }, [startupView, setView]);
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
    z.enum(['profile', 'personality', 'marks', 'portrait']),
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
    loadLayoutNumber(sidebarWidthStorageKey, 362, 220, 520),
  );
  const backStateRef = useRef<ShellSelectionState>({
    activeConversationId,
    contactNotice,
    selectedContactId,
    selectedGroupConversationId,
    view,
  });
  const onReadConversationRef = useRef(onReadConversation);

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

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId),
    [activeConversationId, conversations],
  );
  const selectedContact = useMemo(
    () =>
      contactTab === 'friends'
        ? (contacts.find((contact) => contact.id === selectedContactId) ??
          (expandedContact?.id === selectedContactId ? expandedContact : undefined))
        : undefined,
    [contacts, selectedContactId, expandedContact, contactTab],
  );
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
      setView(nextView);
      history.replaceShell();
      if (nextView === 'messages' && !history.isMobileShell())
        setActiveConversationId(
          (current) =>
            current ??
            (history.shouldAutoSelectConversation() ? (conversations[0]?.id ?? null) : null),
        );
    },
    [conversations, history, setActiveConversationId, setView],
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
      backStateRef.current = {
        ...backStateRef.current,
        contactNotice: kind,
        selectedContactId: null,
        selectedGroupConversationId: null,
        view: 'contacts',
      };
      history.pushShellDetail();
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
      history.pushConversationDetail(conversationId);
      setView('messages');
      setActiveConversationId(conversationId);
    },
    [history, setActiveConversationId, setView],
  );

  const selectContact = useCallback(
    (contact: Contact) => {
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
      history.pushShellDetail();
      setContactNotice(null);
      setContactOverviewOpen(false);
      setSelectedGroupConversationId(conversationId);
    },
    [history, setSelectedGroupConversationId, setContactOverviewOpen, setContactNotice],
  );

  const openContactDetails = useCallback(
    (contact: Contact, tab: ContactWorkspaceTab = 'profile') => {
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
    setSelectedContactId(null);
    setContactOverviewOpen(true);
    history.replaceShell();
  }, [history, setSelectedContactId, setContactOverviewOpen]);

  const backGroup = useCallback(() => {
    setSelectedGroupConversationId(null);
    setContactOverviewOpen(true);
    history.replaceShell();
  }, [history, setSelectedGroupConversationId, setContactOverviewOpen]);

  const backContactNotice = useCallback(() => {
    setContactNotice(null);
    history.replaceShell();
  }, [history, setContactNotice]);

  const backConversation = useCallback(() => {
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
