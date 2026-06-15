// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadLayoutNumber, saveLayoutNumber } from "./layoutStorage";
import { defaultConversationPreference } from "./preferences";
import type {
	Contact,
	ContactNoticeView,
	ContactTab,
	Conversation,
	ConversationPreferences,
	MainView,
} from "./types";

type GroupConversation = Extract<Conversation, { type: "group" }>;

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
	sidebarWidthStorageKey,
	history,
	onReadConversation,
	onOpenContactNotice,
}: UseChatShellControllerOptions) {
	const [view, setView] = useState<MainView>("messages");
	const [query, setQuery] = useState("");
	const [contactTab, setContactTab] = useState<ContactTab>("friends");
	const [contactNotice, setContactNotice] = useState<ContactNoticeView | null>(
		null,
	);
	const [selectedContactId, setSelectedContactId] = useState<string | null>(
		null,
	);
	const [selectedGroupConversationId, setSelectedGroupConversationId] =
		useState<string | null>(null);
	const [activeConversationId, setActiveConversationId] = useState<
		string | null
	>(initialActiveConversationId);
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
	}, [
		activeConversationId,
		contactNotice,
		selectedContactId,
		selectedGroupConversationId,
		view,
	]);

	useEffect(() => {
		if (activeConversationId) {
			onReadConversationRef.current?.(activeConversationId);
		}
	}, [activeConversationId]);

	useEffect(() => {
		function clearMobileDetailState(nextView: "messages" | "contacts") {
			backStateRef.current = {
				activeConversationId: null,
				contactNotice: null,
				selectedContactId: null,
				selectedGroupConversationId: null,
				view: nextView,
			};
			setView(nextView);
			setActiveConversationId(null);
			setSelectedContactId(null);
			setSelectedGroupConversationId(null);
			setContactNotice(null);
		}

		function returnToParentPage() {
			if (!history.isMobileShell()) {
				return;
			}

			const current = backStateRef.current;
			if (current.activeConversationId) {
				clearMobileDetailState("messages");
				window.setTimeout(() => clearMobileDetailState("messages"), 0);
				history.replaceShell();
				return;
			}

			if (
				current.contactNotice ||
				current.selectedContactId ||
				current.selectedGroupConversationId
			) {
				clearMobileDetailState("contacts");
				window.setTimeout(() => clearMobileDetailState("contacts"), 0);
				history.replaceShell();
			}
		}

		window.addEventListener("popstate", returnToParentPage);
		return () => window.removeEventListener("popstate", returnToParentPage);
	}, [history]);

	const activeConversation = useMemo(
		() =>
			conversations.find(
				(conversation) => conversation.id === activeConversationId,
			),
		[activeConversationId, conversations],
	);
	const selectedContact = useMemo(
		() => contacts.find((contact) => contact.id === selectedContactId),
		[contacts, selectedContactId],
	);
	const selectedGroupConversation = useMemo(
		() =>
			conversations.find(
				(conversation): conversation is GroupConversation =>
					conversation.type === "group" &&
					conversation.id === selectedGroupConversationId,
			),
		[conversations, selectedGroupConversationId],
	);
	const messageUnreadCount = useMemo(
		() => countVisibleUnreadConversations(conversations, conversationPrefs),
		[conversations, conversationPrefs],
	);
	const mainOpen = Boolean(
		activeConversation ||
			selectedContact ||
			selectedGroupConversation ||
			contactNotice,
	);

	const switchView = useCallback(
		(nextView: MainView) => {
			setView(nextView);
			history.replaceShell();
			if (nextView === "contacts") {
				setActiveConversationId(null);
				setSelectedGroupConversationId(null);
				setContactNotice(null);
				return;
			}
			if (nextView === "tools") {
				setActiveConversationId(null);
				setSelectedContactId(null);
				setSelectedGroupConversationId(null);
				setContactNotice(null);
				return;
			}
			setSelectedContactId(null);
			setSelectedGroupConversationId(null);
			setContactNotice(null);
			if (history.isMobileShell()) {
				setActiveConversationId(null);
				return;
			}
			setActiveConversationId(
				(current) =>
					current ??
					(history.shouldAutoSelectConversation()
						? (conversations[0]?.id ?? null)
						: null),
			);
		},
		[conversations, history],
	);

	const changeContactTab = useCallback((tab: ContactTab) => {
		setContactTab(tab);
		setContactNotice(null);
		setSelectedContactId(null);
		setSelectedGroupConversationId(null);
	}, []);

	const openContactNotice = useCallback(
		(kind: ContactNoticeView) => {
			backStateRef.current = {
				...backStateRef.current,
				activeConversationId: null,
				contactNotice: kind,
				selectedContactId: null,
				selectedGroupConversationId: null,
				view: "contacts",
			};
			history.pushShellDetail();
			setView("contacts");
			setContactNotice(kind);
			setSelectedContactId(null);
			setSelectedGroupConversationId(null);
			setActiveConversationId(null);
			onOpenContactNotice?.(kind);
		},
		[history, onOpenContactNotice],
	);

	const selectConversation = useCallback(
		(conversationId: string) => {
			history.pushConversationDetail(conversationId);
			setSelectedGroupConversationId(null);
			setActiveConversationId(conversationId);
		},
		[history],
	);

	const selectContact = useCallback(
		(contact: Contact) => {
			history.pushShellDetail();
			setContactNotice(null);
			setSelectedContactId(contact.id);
		},
		[history],
	);

	const selectGroup = useCallback(
		(conversationId: string) => {
			history.pushShellDetail();
			setContactNotice(null);
			setSelectedContactId(null);
			setSelectedGroupConversationId(conversationId);
		},
		[history],
	);

	const openConversation = useCallback(
		(conversationId: string | null) => {
			if (conversationId) {
				history.pushConversationDetail(conversationId);
			}
			setSelectedContactId(null);
			setSelectedGroupConversationId(null);
			setContactNotice(null);
			setView("messages");
			setActiveConversationId(conversationId);
		},
		[history],
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
		history.replaceShell();
	}, [history]);

	const backGroup = useCallback(() => {
		setSelectedGroupConversationId(null);
		history.replaceShell();
	}, [history]);

	const backContactNotice = useCallback(() => {
		setContactNotice(null);
		history.replaceShell();
	}, [history]);

	const backConversation = useCallback(() => {
		setActiveConversationId(null);
		history.replaceShell();
	}, [history]);

	return {
		activeConversation,
		activeConversationId,
		backContact,
		backContactNotice,
		backConversation,
		backGroup,
		changeContactTab,
		contactNotice,
		contactTab,
		mainOpen,
		messageUnreadCount,
		openContactNotice,
		openConversation,
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
