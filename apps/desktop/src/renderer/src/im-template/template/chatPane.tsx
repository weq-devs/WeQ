// @ts-nocheck
import {
	BarChart3,
	Bot,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronsUp,
	CirclePlus,
	Trash2,
	RotateCcw,
	FileText,
	Images,
	FolderOpen,
	Bug,
	MessageSquareText,
	SendHorizontal,
	Smile,
	Sparkles,
} from "lucide-react";
import { resourceUrl } from "../../lib/resourceUrl";
import { useThemeStore } from "../../state/theme";
import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ReplyJumpContext } from "../../components/QqMessageContent";
import { ChatBackdrop } from "../../components/ChatBackdrop";
import { useChatBackdrop } from "../../hooks/useDressSkin";
import type {
	ClipboardEvent as ReactClipboardEvent,
	CSSProperties,
	KeyboardEvent,
	MouseEvent as ReactMouseEvent,
	RefObject,
} from "react";
import { loadLayoutNumber, saveLayoutNumber } from "./layoutStorage";
import { copyTextToClipboard } from "./clipboard";
import { cn } from "./classNames";
import { PROJECT_GROUP_IDS } from "../../../../shared/project_groups";
import {
	chatHeaderTitle,
	isBotConversation,
	resolveMessageSender,
} from "./conversationDisplay";
import { createEmojiToken, parseMessageParts } from "./emojiPacks";
import type { EmojiItem } from "./emojiPacks";
import {
	ComposerResizeHandle,
	focusComposerEnd,
	getActiveComposerMentionTrigger,
	insertComposerNode,
	isNodeInside,
	replaceComposerTextRange,
	restoreComposer,
	serializeComposer,
} from "./composer";
import {
	isComposerActionDisabled,
	resolveComposerActionRegistry,
	type ComposerActionContext,
	type ComposerActionRegistry,
	type ComposerButtonAction,
} from "./composerActions";
import {
	GroupInfoDetailDialog,
	GroupInfoPanel,
	type GroupInfoDetail,
} from "./conversationDetails";
import { EmojiPanel } from "./emojiPanel";
import { loadHiddenMessageIds, saveHiddenMessageIds } from "./hiddenMessages";
import { MessageBubble } from "./messageBubble";
import { MessageContextMenu } from "./messageContextMenu";
import type { MessageContextMenuState } from "./messageContextMenu";
import type { MessageRenderer } from "./messageRenderers";
import { filterMentionMembers, mentionText } from "./mentions";
import { MessageTimeDivider, shouldShowMessageTime } from "./messageTime";
import { MessageGapDivider, messageGapCount } from "./messageGap";
import { defaultConversationPreference } from "./preferences";
import { Avatar, ChatMessagesSkeleton, EmptyState } from "./primitives";
import type {
	Conversation,
	ConversationPreference,
	GroupMember,
	Message,
	MessageAction,
	User,
} from "./types";
import { displayUserName } from "./user";
import { OnlineStatus } from "../../components/OnlineStatus";
import { GrayTipPokeMessage } from '../../components/GrayTipPokeMessage';
import { GrayTipRevokeMessage } from '../../components/GrayTipRevokeMessage';
import { GrayTipGroupMessage } from '../../components/GrayTipGroupMessage';
import { GrayTipXmlMessage } from '../../components/GrayTipXmlMessage';
import { GrayTipFileRecvMessage } from '../../components/GrayTipFileRecvMessage';
import { GrayTipTempSessionMessage } from '../../components/GrayTipTempSessionMessage';
import { GroupCallEndedMessage, GROUP_CALL_ENDED_SUBTYPES } from '../../components/GroupCallEndedMessage';
import { QqDynamic } from '../../components/QqDynamic';
import { MessageDecorationCard } from '../../components/MessageDecorationCard';

const composerHeightStorageKey = "chat-template.layout.composerHeight";
const groupInfoCollapsedStorageKey = "chat-template.layout.groupInfoCollapsed";
const mobileComposerMaxLines = 4;

type MentionMenuState = {
	query: string;
	activeIndex: number;
	members: GroupMember[];
};

type UnreadJumpState = {
	conversationId: string;
	remaining: number;
	startScrollTop?: number;
	targetScrollTop?: number;
	total: number;
};

type UnreadJumpSeed = {
	conversationId: string;
	total: number;
};

function loadGroupInfoCollapsed() {
	return localStorage.getItem(groupInfoCollapsedStorageKey) === "1";
}

function saveGroupInfoCollapsed(value: boolean) {
	localStorage.setItem(groupInfoCollapsedStorageKey, value ? "1" : "0");
}

function _hasGroupAnnouncements(conversation: Conversation) {
	return (
		conversation.type === "group" &&
		(Boolean(conversation.group.announcement?.trim()) ||
			Boolean(conversation.group.bulletins?.length))
	);
}

function hasGroupEssence(conversation: Conversation) {
	return (
		conversation.type === "group" &&
		Boolean(conversation.group.essenceMessages?.length)
	);
}

function getMessageDownloadUrl(message: Message) {
	const markdownImage = message.body.match(
		/!\[[^\]\n]*\]\((https?:\/\/[^\s)]+)\)/i,
	)?.[1];
	if (markdownImage) {
		return markdownImage;
	}

	for (const part of parseMessageParts(message.body)) {
		if (
			part.type === "emoji" &&
			part.item.type === "image" &&
			part.item.large
		) {
			return part.item.value;
		}
	}

	return undefined;
}

function imageFilenameFromUrl(url: string) {
	try {
		const { pathname } = new URL(url);
		const filename = pathname.split("/").filter(Boolean).pop();
		return filename || "chat-image";
	} catch {
		return "chat-image";
	}
}

function formatUnreadJumpCount(value: number) {
	return value > 99 ? "99+" : String(value);
}

/**
 * How many messages were appended at the tail since `lastId`. Falls back to
 * "1" when the previous tail can't be located (e.g. it scrolled out of the
 * loaded window) so the pill still nudges the user.
 */
function countAppendedMessages(lastId: string | null, messages: Message[]) {
	if (!lastId) {
		return messages.length > 0 ? 1 : 0;
	}
	const index = messages.findIndex((message) => message.id === lastId);
	if (index === -1) {
		return 1;
	}
	return messages.length - 1 - index;
}

function isMobileComposerViewport() {
	return window.matchMedia("(max-width: 760px)").matches;
}

export function ChatPane({
	user,
	conversation,
	messages,
	composerActions,
	messageRenderers,
	loading,
	atLatest = true,
	preference,
	onLoadMoreGroupMembers,
	groupMembersLoading,
	groupMembersError,
	onSend,
	onMessageAction,
	draft,
	onDraftChange,
	onDraftClear,
	onBack,
	onEditRaw,
	onDeleteMessage,
	onOpenGroupAlbums,
	onOpenGroupFiles,
	onOpenGroupAnnouncements,
	onOpenGroupEssence,
	onOpenGroupAnalytics,
	onOpenGroupBug,
	groupBugOnline,
	onOpenBuddyAnalytics,
	onOpenGroupMember,
	onAddMessage,
	onViewDeleted,
	onViewRecalled,
	onOpenGapMessages,
	deletedIds,
	onRestoreMessage,
}: {
	user: User;
	conversation: Conversation | undefined;
	messages: Message[];
	composerActions?: Partial<ComposerActionRegistry>;
	messageRenderers?: MessageRenderer[];
	loading: boolean;
	/**
	 * Whether `messages` is the live latest-anchored window. False while the host
	 * shows a detached history window (reply-jump context / downward history
	 * paging); in that mode tail changes are programmatic, not live arrivals, so
	 * the "new message" pill and auto-scroll-to-bottom are suppressed.
	 */
	atLatest?: boolean;
	preference: ConversationPreference | undefined;
	onLoadMoreGroupMembers?: () => void;
	groupMembersLoading?: boolean;
	groupMembersError?: string | null;
	onSend: (body: string) => Promise<void>;
	onMessageAction?: (message: Message, action: MessageAction) => Promise<void>;
	draft: string;
	onDraftChange: (conversationId: string, value: string) => void;
	onDraftClear: (conversationId: string) => void;
	onBack: () => void;
	onEditRaw?: (message: Message) => void;
	onDeleteMessage?: (message: Message, conversation: Conversation) => void | Promise<void>;
	onOpenGroupAlbums?: (conversation: Extract<Conversation, { type: "group" }>) => void;
	onOpenGroupFiles?: (conversation: Extract<Conversation, { type: "group" }>) => void;
	onOpenGroupAnnouncements?: (conversation: Extract<Conversation, { type: "group" }>) => void;
	onOpenGroupEssence?: (conversation: Extract<Conversation, { type: "group" }>) => void;
	onOpenGroupAnalytics?: (conversation: Extract<Conversation, { type: "group" }>) => void;
	onOpenGroupBug?: (conversation: Extract<Conversation, { type: "group" }>) => void;
	/** QQ 在线状态 —— 决定「反馈 bug」图标亮/灰。 */
	groupBugOnline?: boolean;
	onOpenBuddyAnalytics?: (conversation: Extract<Conversation, { type: "direct" }>) => void;
	onOpenGroupMember?: (member: User, anchor: { x: number; y: number }) => void;
	onAddMessage?: (conversation: Conversation) => void;
	onViewDeleted?: (conversation: Conversation) => void;
	onViewRecalled?: (conversation: Conversation) => void;
	/** 缺失消息占位条点击：携带占位条两侧消息的 seq（开区间即缺失窗口）。 */
	onOpenGapMessages?: (gap: {
		conversation: Conversation;
		previousSeq: string;
		currentSeq: string;
		count: number;
	}) => void;
	/** msgIds WeQ deleted in this conversation — rendered in place under a translucent overlay. */
	deletedIds?: Set<string>;
	/** Restore one WeQ-deleted message (the overlay's hover button). */
	onRestoreMessage?: (msgId: string) => Promise<void>;
}) {
	// 空态占位图按深浅色切换(im_1.png / im_2.jpg),订阅主题以即时跟随。
	const theme = useThemeStore((s) => s.resolved);
	// 复用 replyJump 的跳转能力（含翻页/重建窗口），供群精华消息跳转使用。
	const jumpToSeq = useContext(ReplyJumpContext);
	const backdrop = useChatBackdrop();
	const [body, setBody] = useState("");
	const [sending, setSending] = useState(false);
	const [composerHeight, setComposerHeight] = useState(() =>
		loadLayoutNumber(composerHeightStorageKey, 190, 150, 340),
	);
	const [groupInfoDetail, setGroupInfoDetail] = useState<GroupInfoDetail | null>(null);
	const [groupInfoCollapsed, setGroupInfoCollapsed] = useState(
		loadGroupInfoCollapsed,
	);
	const [emojiOpen, setEmojiOpen] = useState(false);
	const [toolsOpen, setToolsOpen] = useState(false);
	const [activeEmojiPackId, setActiveEmojiPackId] = useState("emoji");
	const [contextMenu, setContextMenu] =
		useState<MessageContextMenuState | null>(null);
	const [decorationCard, setDecorationCard] = useState<{
		decoration: { fontId: number; bubbleId: number; widgetId: number } | null;
		anchor: { x: number; y: number };
	} | null>(null);
	// Local "清空聊天记录" hide set (localStorage). Per-message delete no longer
	// touches this — deleted messages stay visible under an overlay; this set
	// only backs the clear-conversation action.
	const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<string>>(
		new Set(),
	);
	const [mentionMenu, setMentionMenu] = useState<MentionMenuState | null>(null);
	const [unreadJump, setUnreadJump] = useState<UnreadJumpState | null>(null);
	// Count of newly-arrived (live) messages while the user is reading history.
	// Surfaces the floating "jump to bottom" pill; cleared once at the bottom.
	const [newMessagePill, setNewMessagePill] = useState(0);
	const [clearMessagesConfirmOpen, setClearMessagesConfirmOpen] =
		useState(false);
	const [mobileComposerEditorHeight, setMobileComposerEditorHeight] =
		useState(42);
	const [mobileComposerLong, setMobileComposerLong] = useState(false);
	const [mobileComposerExpanded, setMobileComposerExpanded] = useState(false);
	const emojiPanelRef = useRef<HTMLDivElement | null>(null);
	const emojiButtonRef = useRef<HTMLButtonElement | null>(null);
	const expandedEmojiButtonRef = useRef<HTMLButtonElement | null>(null);

	function handleOpenGroupInfoDetail(detail: GroupInfoDetail) {
		setGroupInfoDetail(detail);
	}

	const toolsPanelRef = useRef<HTMLDivElement | null>(null);
	const toolsButtonRef = useRef<HTMLButtonElement | null>(null);
	const mentionMenuRef = useRef<HTMLDivElement | null>(null);
	const composerEditorRef = useRef<HTMLDivElement | null>(null);
	const expandedComposerEditorRef = useRef<HTMLDivElement | null>(null);
	const composerSelectionRef = useRef<Range | null>(null);
	const messageScrollRef = useRef<HTMLDivElement | null>(null);
	const endRef = useRef<HTMLDivElement | null>(null);
	// Tracks whether the view is pinned to the bottom of the message list.
	// Drives auto-scroll-on-new-message vs. "new messages" pill behaviour.
	const atBottomRef = useRef(true);
	// Last message id we auto-scrolled / accounted for, to detect new arrivals.
	const lastMessageIdRef = useRef<string | null>(null);
	// Conversation id the scroll-tracking refs above currently describe.
	const scrollConversationRef = useRef<string | null>(null);
	const unreadSeedRef = useRef<UnreadJumpSeed | null>(null);
	const unreadConversationRef = useRef<string | null>(null);
	const unreadScrollFrameRef = useRef<number | null>(null);
	const visibleMessages = useMemo(
		() => messages.filter((message) => !hiddenMessageIds.has(message.id)),
		[messages, hiddenMessageIds],
	);

	// 下面几个 effect 只该在会话/消息变化时跑，但正文里要调用这些每次渲染都重建的
	// 函数。用 ref 转发拿最新实现，避免把它们塞进依赖导致 effect 每次渲染重跑。
	const scrollMessagesToBottomRef = useRef<() => void>(() => {});
	const updateUnreadJumpRemainingRef = useRef<() => void>(() => {});
	const scheduleMobileComposerMeasureRef = useRef<(editor?: HTMLElement | null) => void>(
		() => {},
	);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const bodyRef = useRef(body);
	bodyRef.current = body;

	useLayoutEffect(() => {
		const conversationId = conversation?.id ?? null;
		if (unreadConversationRef.current === conversationId) {
			return;
		}

		unreadConversationRef.current = conversationId;
		setUnreadJump(null);
		const total = Math.max(0, conversation?.unreadCount ?? 0);
		unreadSeedRef.current =
			conversationId && total > 0
				? {
						conversationId,
						total,
					}
				: null;
	}, [conversation?.id, conversation?.unreadCount]);

	useLayoutEffect(() => {
		const seed = unreadSeedRef.current;
		if (
			!seed ||
			seed.conversationId !== conversation?.id ||
			loading ||
			visibleMessages.length === 0
		) {
			return;
		}

		const total = Math.min(seed.total, visibleMessages.length);
		unreadSeedRef.current = null;
		setUnreadJump(
			total > 0
				? {
						conversationId: seed.conversationId,
						remaining: total,
						total,
					}
				: null,
		);
	}, [conversation?.id, loading, visibleMessages]);

	useLayoutEffect(() => {
		const conversationId = conversation?.id ?? null;
		const newestId =
			visibleMessages[visibleMessages.length - 1]?.id ?? null;

		// Conversation switched (or first paint): jump to bottom, reset trackers.
		if (scrollConversationRef.current !== conversationId) {
			scrollConversationRef.current = conversationId;
			lastMessageIdRef.current = newestId;
			atBottomRef.current = true;
			setNewMessagePill(0);
			scrollMessagesToBottomRef.current();
			const frame = window.requestAnimationFrame(() =>
				scrollMessagesToBottomRef.current(),
			);
			return () => window.cancelAnimationFrame(frame);
		}

		// Nothing new at the tail (e.g. older history was prepended above).
		if (newestId === lastMessageIdRef.current) {
			return;
		}

		const prevId = lastMessageIdRef.current;
		// The window was swapped wholesale (reply-jump rebuild) when the previous
		// tail is no longer present — that's not a live arrival.
		const replaced =
			prevId !== null && !visibleMessages.some((message) => message.id === prevId);
		const appended = countAppendedMessages(prevId, visibleMessages);
		lastMessageIdRef.current = newestId;

		// Detached history window (reply-jump context or downward history paging):
		// tail changes are programmatic. Don't pill, don't yank to the bottom — the
		// host positions the view itself.
		if (replaced || !atLatest) {
			return;
		}

		// Pinned to bottom → follow the new message down, no pill.
		if (atBottomRef.current) {
			setNewMessagePill(0);
			scrollMessagesToBottomRef.current();
			const frame = window.requestAnimationFrame(() =>
				scrollMessagesToBottomRef.current(),
			);
			return () => window.cancelAnimationFrame(frame);
		}

		// Reading history → surface the pill instead of yanking the view down.
		setNewMessagePill((current) => current + appended);
		return;
	}, [visibleMessages, conversation?.id, loading, atLatest]);

	// updateUnreadJumpRemaining 会写回 unreadJump.remaining，所以这里只认「换会话 /
	// 换未读总数」这两个稳定信号，不能整体依赖 unreadJump，否则每次滚动都要多跑一轮。
	const unreadJumpKey = unreadJump
		? `${unreadJump.conversationId}:${unreadJump.total}`
		: null;

	useLayoutEffect(() => {
		if (!unreadJumpKey) {
			return;
		}

		updateUnreadJumpRemainingRef.current();
		const frame = window.requestAnimationFrame(() =>
			updateUnreadJumpRemainingRef.current(),
		);
		return () => window.cancelAnimationFrame(frame);
	}, [unreadJumpKey, visibleMessages, loading]);

	useEffect(
		() => () => {
			if (unreadScrollFrameRef.current !== null) {
				window.cancelAnimationFrame(unreadScrollFrameRef.current);
			}
		},
		[],
	);

	useEffect(() => {
		setGroupInfoDetail(null);
		setEmojiOpen(false);
		setToolsOpen(false);
		setContextMenu(null);
		setMentionMenu(null);
		setClearMessagesConfirmOpen(false);
		setMobileComposerExpanded(false);
		setHiddenMessageIds(loadHiddenMessageIds(conversation?.id));
	}, [conversation?.id]);

	useEffect(() => {
		const editor = composerEditorRef.current;
		const currentDraft = draftRef.current;
		setBody(currentDraft);
		composerSelectionRef.current = null;
		if (editor) {
			restoreComposer(editor, currentDraft);
			scheduleMobileComposerMeasureRef.current(editor);
		}
	}, [conversation?.id]);

	useEffect(() => {
		if (!mobileComposerExpanded) {
			return;
		}

		const editor = expandedComposerEditorRef.current;
		if (!editor) {
			return;
		}

		restoreComposer(editor, bodyRef.current);
		composerSelectionRef.current = null;
		const frame = window.requestAnimationFrame(() => focusComposerEnd(editor));
		return () => window.cancelAnimationFrame(frame);
	}, [mobileComposerExpanded]);

	// 只关心「菜单开着 / 关着」和它锚在哪条消息上；重新定位读的是 setContextMenu 的
	// 函数式更新，所以不需要整体依赖 contextMenu（它每次重定位都会变新对象）。
	const contextMenuOpen = contextMenu !== null;
	const contextMenuVariant = contextMenu?.variant ?? null;
	const contextMenuMessageId = contextMenu?.message.id ?? null;

	useEffect(() => {
		if (!contextMenuOpen) {
			return;
		}

		function closeMenu() {
			setContextMenu(null);
		}

		function closeOnEscape(event: globalThis.KeyboardEvent) {
			if (event.key === "Escape") {
				closeMenu();
			}
		}

		document.addEventListener("mousedown", closeMenu);
		document.addEventListener("keydown", closeOnEscape);
		window.addEventListener("resize", closeMenu);
		return () => {
			document.removeEventListener("mousedown", closeMenu);
			document.removeEventListener("keydown", closeOnEscape);
			window.removeEventListener("resize", closeMenu);
		};
	}, [contextMenuOpen]);

	// Keep the desktop context menu glued to its message as the list scrolls,
	// instead of floating in place. Dismisses once the message leaves the list
	// viewport. Mobile menus (long-press sheet) keep their fixed placement.
	useEffect(() => {
		if (!contextMenuMessageId || contextMenuVariant === "mobile") {
			return;
		}
		const scroll = messageScrollRef.current;
		if (!scroll) {
			return;
		}

		let frame = 0;
		function reposition() {
			if (frame) {
				return;
			}
			frame = window.requestAnimationFrame(() => {
				frame = 0;
				setContextMenu((current) => {
					if (!current || current.variant === "mobile") {
						return current;
					}
					const container = messageScrollRef.current;
					if (!container) {
						return current;
					}
					const idSelector = current.message.id.replace(/["\\]/g, "\\$&");
					const el = container.querySelector<HTMLElement>(
						`[data-message-id="${idSelector}"]`,
					);
					if (!el) {
						return current;
					}
					const rect = el.getBoundingClientRect();
					const bounds = container.getBoundingClientRect();
					// Message scrolled out of the list viewport → dismiss the menu.
					if (rect.bottom < bounds.top || rect.top > bounds.bottom) {
						return null;
					}
					const x = Math.min(
						rect.left + (current.anchorOffsetX ?? 0),
						window.innerWidth - 126,
					);
					const y = Math.min(
						Math.max(rect.top + (current.anchorOffsetY ?? 0), 8),
						window.innerHeight - 84,
					);
					return { ...current, x, y };
				});
			});
		}

		scroll.addEventListener("scroll", reposition, { passive: true });
		return () => {
			scroll.removeEventListener("scroll", reposition);
			if (frame) {
				window.cancelAnimationFrame(frame);
			}
		};
	}, [contextMenuMessageId, contextMenuVariant]);

	useEffect(() => {
		if (!emojiOpen) {
			return;
		}

		function closeEmojiFromOutside(event: globalThis.MouseEvent) {
			const target = event.target;
			if (!(target instanceof Node)) {
				return;
			}
			if (
				emojiPanelRef.current?.contains(target) ||
				emojiButtonRef.current?.contains(target) ||
				expandedEmojiButtonRef.current?.contains(target) ||
				toolsButtonRef.current?.contains(target)
			) {
				return;
			}
			setEmojiOpen(false);
		}

		function closeEmojiOnEscape(event: globalThis.KeyboardEvent) {
			if (event.key === "Escape") {
				setEmojiOpen(false);
			}
		}

		document.addEventListener("mousedown", closeEmojiFromOutside);
		document.addEventListener("keydown", closeEmojiOnEscape);
		return () => {
			document.removeEventListener("mousedown", closeEmojiFromOutside);
			document.removeEventListener("keydown", closeEmojiOnEscape);
		};
	}, [emojiOpen]);

	useEffect(() => {
		if (!toolsOpen) {
			return;
		}

		function closeToolsFromOutside(event: globalThis.MouseEvent) {
			const target = event.target;
			if (!(target instanceof Node)) {
				return;
			}
			if (
				toolsPanelRef.current?.contains(target) ||
				toolsButtonRef.current?.contains(target) ||
				emojiButtonRef.current?.contains(target) ||
				expandedEmojiButtonRef.current?.contains(target)
			) {
				return;
			}
			setToolsOpen(false);
		}

		function closeToolsOnEscape(event: globalThis.KeyboardEvent) {
			if (event.key === "Escape") {
				setToolsOpen(false);
			}
		}

		document.addEventListener("mousedown", closeToolsFromOutside);
		document.addEventListener("keydown", closeToolsOnEscape);
		return () => {
			document.removeEventListener("mousedown", closeToolsFromOutside);
			document.removeEventListener("keydown", closeToolsOnEscape);
		};
	}, [toolsOpen]);

	useEffect(() => {
		if (!mentionMenu) {
			return;
		}

		function closeMentionFromOutside(event: globalThis.MouseEvent) {
			const target = event.target;
			if (!(target instanceof Node)) {
				return;
			}
			if (
				mentionMenuRef.current?.contains(target) ||
				composerEditorRef.current?.contains(target) ||
				expandedComposerEditorRef.current?.contains(target)
			) {
				return;
			}
			setMentionMenu(null);
		}

		document.addEventListener("mousedown", closeMentionFromOutside);
		return () => {
			document.removeEventListener("mousedown", closeMentionFromOutside);
		};
	}, [mentionMenu]);

	function currentComposerEditor() {
		if (mobileComposerExpanded) {
			return expandedComposerEditorRef.current ?? composerEditorRef.current;
		}
		return composerEditorRef.current;
	}

	function saveComposerSelection(editor = currentComposerEditor()) {
		const selection = window.getSelection();
		if (!editor || !selection || selection.rangeCount === 0) {
			return;
		}

		const range = selection.getRangeAt(0);
		if (
			isNodeInside(editor, range.startContainer) &&
			isNodeInside(editor, range.endContainer)
		) {
			composerSelectionRef.current = range.cloneRange();
		}
	}

	function syncComposerBody(editor = currentComposerEditor()) {
		if (!editor) {
			return;
		}

		setComposerBody(serializeComposer(editor));
		saveComposerSelection(editor);
		if (editor === composerEditorRef.current) {
			scheduleMobileComposerMeasure(editor);
		}
		updateMentionMenu(editor);
	}

	function insertComposerText(value: string) {
		const editor = currentComposerEditor();
		if (!editor) {
			setComposerBody(`${body}${value}`);
			return;
		}

		insertComposerNode(
			editor,
			document.createTextNode(value),
			composerSelectionRef.current,
		);
		syncComposerBody();
	}

	function insertMention(member: GroupMember) {
		if (currentPreference.blocked || sending) {
			return;
		}

		const editor = currentComposerEditor();
		const label = mentionText(member);
		if (!editor) {
			setComposerBody(`${body}${label} `);
			setMentionMenu(null);
			return;
		}

		const trigger = getActiveComposerMentionTrigger(
			editor,
			composerSelectionRef.current,
		);
		const token = document.createElement("span");
		token.className = cn("composer-mention-token");
		token.contentEditable = "false";
		token.dataset.chatMention = label;
		token.textContent = label;

		if (trigger) {
			replaceComposerTextRange(editor, trigger.start, trigger.end, [
				token,
				document.createTextNode(" "),
			]);
		} else {
			insertComposerNode(editor, token, composerSelectionRef.current);
			insertComposerNode(editor, document.createTextNode(" "), null);
		}

		syncComposerBody(editor);
		setMentionMenu(null);
	}

	function insertComposerLineBreak() {
		const editor = currentComposerEditor();
		if (!editor) {
			setComposerBody(`${body}\n`);
			return;
		}

		insertComposerNode(
			editor,
			document.createElement("br"),
			composerSelectionRef.current,
		);
		insertComposerNode(editor, document.createTextNode("\u200b"), null);
		syncComposerBody(editor);
	}

	function insertEmoji(item: EmojiItem) {
		if (currentPreference.blocked || sending) {
			return;
		}

		const mobileEmojiMode = isMobileComposerViewport();
		if (mobileEmojiMode && item.type === "image" && item.large) {
			void sendEmojiMessage(item);
			return;
		}

		if (item.type === "text") {
			insertComposerText(item.value);
			if (!mobileEmojiMode) {
				setEmojiOpen(false);
			}
			return;
		}

		const editor = currentComposerEditor();
		if (!editor) {
			setComposerBody(`${body}${createEmojiToken(item)}`);
			return;
		}

		const image = document.createElement("img");
		image.src = item.value;
		image.alt = `[${item.name}]`;
		image.title = item.name;
		image.draggable = false;
		image.dataset.chatToken = createEmojiToken(item);
		image.className = cn(
			item.large
				? "composer-token-image composer-sticker-token"
				: "composer-token-image composer-inline-emoji",
		);

		insertComposerNode(editor, image, composerSelectionRef.current);
		syncComposerBody();
		if (!mobileEmojiMode) {
			setEmojiOpen(false);
		}
	}

	async function sendEmojiMessage(item: EmojiItem) {
		setSending(true);
		try {
			await onSend(createEmojiToken(item));
		} finally {
			setSending(false);
		}
	}

	async function submitMessage() {
		const editor = currentComposerEditor();
		const nextBody = editor ? serializeComposer(editor) : body;
		const trimmed = nextBody.trim();
		if (!trimmed || sending) {
			return;
		}

		setSending(true);
		setComposerBody("");
		if (conversation) {
			onDraftClear(conversation.id);
		}
		if (editor) {
			editor.innerHTML = "";
			composerSelectionRef.current = null;
		}
		if (
			expandedComposerEditorRef.current &&
			expandedComposerEditorRef.current !== editor
		) {
			expandedComposerEditorRef.current.innerHTML = "";
		}
		if (composerEditorRef.current && composerEditorRef.current !== editor) {
			composerEditorRef.current.innerHTML = "";
		}
		resetMobileComposerHeight();
		setMobileComposerExpanded(false);
		setEmojiOpen(false);
		setToolsOpen(false);
		try {
			await onSend(trimmed);
		} finally {
			setSending(false);
			window.requestAnimationFrame(() =>
				focusComposerEnd(composerEditorRef.current),
			);
		}
	}

	function handleComposerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.nativeEvent.isComposing || event.key === "Process") {
			return;
		}

		if (mentionMenu) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setMentionMenu((current) => {
					if (!current || current.members.length === 0) {
						return current;
					}
					const offset = event.key === "ArrowDown" ? 1 : -1;
					return {
						...current,
						activeIndex:
							(current.activeIndex + offset + current.members.length) %
							current.members.length,
					};
				});
				return;
			}

			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				const member =
					mentionMenu.members[mentionMenu.activeIndex] ??
					mentionMenu.members[0];
				if (member) {
					insertMention(member);
				}
				return;
			}

			if (event.key === "Escape") {
				event.preventDefault();
				setMentionMenu(null);
				return;
			}
		}

		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			if (mobileComposerExpanded) {
				insertComposerLineBreak();
				return;
			}
			void submitMessage();
		}
	}

	function handleComposerPaste(event: ReactClipboardEvent<HTMLDivElement>) {
		event.preventDefault();
		insertComposerText(event.clipboardData.getData("text/plain"));
	}

	function updateMentionMenu(editor = currentComposerEditor()) {
		if (!editor || conversation?.type !== "group") {
			setMentionMenu(null);
			return;
		}

		const trigger = getActiveComposerMentionTrigger(
			editor,
			composerSelectionRef.current,
		);
		if (!trigger) {
			setMentionMenu(null);
			return;
		}

		const members = filterMentionMembers(conversation, trigger.query, user.id);
		if (members.length === 0) {
			setMentionMenu(null);
			return;
		}

		setMentionMenu((current) => ({
			query: trigger.query,
			members,
			activeIndex:
				current?.query === trigger.query
					? Math.min(current.activeIndex, members.length - 1)
					: 0,
		}));
	}

	function openMessageMenu(event: ReactMouseEvent, message: Message) {
		if (window.matchMedia("(max-width: 760px)").matches) {
			event.preventDefault();
			const rect = event.currentTarget.getBoundingClientRect();
			openMobileMessageMenu(
				{
					x: rect.left + rect.width / 2,
					y: rect.bottom,
				},
				message,
			);
			return;
		}
		event.preventDefault();
		window.getSelection()?.removeAllRanges();
		// Record where the click landed inside the message row so the menu can
		// track that row as the list scrolls (see the reposition effect below).
		const anchorEl = (event.currentTarget as HTMLElement).closest?.(
			"[data-message-id]",
		) as HTMLElement | null;
		const anchorRect = anchorEl?.getBoundingClientRect();
		setContextMenu({
			message,
			downloadUrl: getMessageDownloadUrl(message),
			x: Math.min(event.clientX, window.innerWidth - 126),
			y: Math.min(event.clientY, window.innerHeight - 84),
			variant: "desktop",
			anchorOffsetX: anchorRect ? event.clientX - anchorRect.left : undefined,
			anchorOffsetY: anchorRect ? event.clientY - anchorRect.top : undefined,
		});
	}

	function openMobileMessageMenu(
		point: { x: number; y: number },
		message: Message,
	) {
		const menuHalfWidth = 112;
		const maxTop = Math.max(92, window.innerHeight - 166);
		setContextMenu({
			message,
			downloadUrl: getMessageDownloadUrl(message),
			x: Math.min(
				Math.max(point.x, menuHalfWidth),
				window.innerWidth - menuHalfWidth,
			),
			y: Math.min(Math.max(point.y + 10, 92), maxTop),
			variant: "mobile",
		});
	}

	function updateComposerHeight(height: number) {
		setComposerHeight(height);
		saveLayoutNumber(composerHeightStorageKey, height);
	}

	function setComposerBody(value: string) {
		setBody(value);
		if (conversation) {
			onDraftChange(conversation.id, value);
		}
	}

	function scheduleMobileComposerMeasure(editor = composerEditorRef.current) {
		if (!editor) {
			return;
		}

		window.requestAnimationFrame(() => {
			const styles = window.getComputedStyle(editor);
			const lineHeight = Number.parseFloat(styles.lineHeight) || 22;
			const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
			const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
			const minHeight = Math.ceil(lineHeight + paddingTop + paddingBottom);
			const maxHeight = Math.ceil(
				lineHeight * mobileComposerMaxLines + paddingTop + paddingBottom,
			);
			const contentHeight = serializeComposer(editor).trim()
				? measureComposerContentHeight(editor)
				: minHeight;
			const nextHeight = Math.min(
				Math.max(contentHeight, minHeight),
				maxHeight,
			);
			const nextLong = contentHeight >= maxHeight - 1;

			setMobileComposerEditorHeight((current) =>
				current === nextHeight ? current : nextHeight,
			);
			setMobileComposerLong((current) =>
				current === nextLong ? current : nextLong,
			);
		});
	}
	scheduleMobileComposerMeasureRef.current = scheduleMobileComposerMeasure;

	function measureComposerContentHeight(editor: HTMLDivElement) {
		const rect = editor.getBoundingClientRect();
		const clone = editor.cloneNode(true) as HTMLDivElement;

		clone.contentEditable = "false";
		clone.removeAttribute("id");
		clone.style.position = "fixed";
		clone.style.left = "-10000px";
		clone.style.top = "0";
		clone.style.zIndex = "-1";
		clone.style.visibility = "hidden";
		clone.style.pointerEvents = "none";
		clone.style.width = `${Math.max(1, rect.width)}px`;
		clone.style.height = "auto";
		clone.style.minHeight = "0";
		clone.style.maxHeight = "none";
		clone.style.overflow = "visible";

		document.body.appendChild(clone);
		const height = Math.ceil(clone.scrollHeight);
		clone.remove();
		return height;
	}

	function resetMobileComposerHeight() {
		setMobileComposerEditorHeight(42);
		setMobileComposerLong(false);
	}

	function openMobileComposerExpanded() {
		setContextMenu(null);
		setToolsOpen(false);
		setEmojiOpen(false);
		setMobileComposerExpanded(true);
	}

	function toggleEmojiPanel() {
		setContextMenu(null);
		setToolsOpen(false);
		setEmojiOpen((open) => (toolsOpen ? true : !open));
	}

	function toggleToolsPanel() {
		setContextMenu(null);
		setEmojiOpen(false);
		setToolsOpen((open) => (emojiOpen ? true : !open));
	}

	function closeMobileComposerExpanded() {
		const editor = expandedComposerEditorRef.current;
		const nextBody = editor ? serializeComposer(editor) : body;
		setComposerBody(nextBody);
		setMobileComposerExpanded(false);
		setEmojiOpen(false);

		window.requestAnimationFrame(() => {
			const compactEditor = composerEditorRef.current;
			if (!compactEditor) {
				return;
			}
			restoreComposer(compactEditor, nextBody);
			scheduleMobileComposerMeasure(compactEditor);
			focusComposerEnd(compactEditor);
		});
	}

	function scrollMessagesToBottom() {
		const scroll = messageScrollRef.current;
		if (!scroll) {
			return;
		}
		scroll.scrollTop = scroll.scrollHeight;
		atBottomRef.current = true;
		setNewMessagePill(0);
	}
	scrollMessagesToBottomRef.current = scrollMessagesToBottom;

	function isScrolledToBottom() {
		const scroll = messageScrollRef.current;
		if (!scroll) {
			return true;
		}
		// Tolerance covers sub-pixel rounding and short content.
		return (
			scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 48
		);
	}

	function handleMessageScroll() {
		const bottom = isScrolledToBottom();
		atBottomRef.current = bottom;
		if (bottom && newMessagePill > 0) {
			setNewMessagePill(0);
		}

		if (!unreadJump || unreadScrollFrameRef.current !== null) {
			return;
		}

		unreadScrollFrameRef.current = window.requestAnimationFrame(() => {
			unreadScrollFrameRef.current = null;
			updateUnreadJumpRemaining();
		});
	}

	function updateUnreadJumpRemaining() {
		const scroll = messageScrollRef.current;
		if (!scroll || !unreadJump) {
			return;
		}

		const firstUnread = unreadMessageElements(unreadJump)[0];
		if (!firstUnread) {
			setUnreadJump(null);
			return;
		}

		const scrollRect = scroll.getBoundingClientRect();
		const firstUnreadTop = firstUnread.getBoundingClientRect().top;
		const targetScrollTop =
			unreadJump.targetScrollTop ??
			Math.max(0, scroll.scrollTop + firstUnreadTop - scrollRect.top - 12);
		const startScrollTop = unreadJump.startScrollTop ?? scroll.scrollTop;

		if (
			targetScrollTop >= startScrollTop - 1 ||
			scroll.scrollTop <= targetScrollTop + 1
		) {
			setUnreadJump(null);
			return;
		}

		const progress =
			(scroll.scrollTop - targetScrollTop) / (startScrollTop - targetScrollTop);
		const remaining = Math.max(
			1,
			Math.ceil(unreadJump.total * Math.min(1, progress)),
		);

		setUnreadJump((current) => {
			if (!current || current.conversationId !== unreadJump.conversationId) {
				return current;
			}
			return current.remaining === remaining &&
				current.startScrollTop === startScrollTop &&
				current.targetScrollTop === targetScrollTop
				? current
				: {
						...current,
						remaining,
						startScrollTop,
						targetScrollTop,
					};
		});
	}
	updateUnreadJumpRemainingRef.current = updateUnreadJumpRemaining;

	function unreadMessageElements(state = unreadJump) {
		const scroll = messageScrollRef.current;
		if (!scroll || !state) {
			return [];
		}

		const ids = new Set(
			visibleMessages.slice(-state.total).map((message) => message.id),
		);

		return Array.from(
			scroll.querySelectorAll<HTMLElement>(".message-line[data-message-id]"),
		).filter((element) => ids.has(element.dataset.messageId ?? ""));
	}

	function jumpToFirstUnreadMessage() {
		const firstUnread = unreadMessageElements()[0];
		if (!firstUnread) {
			setUnreadJump(null);
			return;
		}

		firstUnread.scrollIntoView({
			behavior: "smooth",
			block: "start",
		});
		setUnreadJump(null);
	}

	function toggleGroupInfoCollapsed() {
		setGroupInfoCollapsed((current) => {
			const next = !current;
			saveGroupInfoCollapsed(next);
			return next;
		});
	}

	async function copyMessage(message: Message) {
		const selectedText = window.getSelection()?.toString().trim();
		// Non-copyable messages (images/files/cards) render an empty body — fall
		// back to a `msgid=xxx` reference so there's always something on the clipboard.
		const body = message.body?.trim() ? message.body : `msgid=${message.id}`;
		await copyTextToClipboard(selectedText || body);
		setContextMenu(null);
	}

	// QQ-style delete: the DB row's type columns become (1,1) and the message
	// STAYS in the chat, rendered under a translucent overlay (no local hiding).
	function deleteMessage(message: Message) {
		if (!conversation) {
			return;
		}
		setContextMenu(null);
		setDecorationCard(null);
		void onDeleteMessage?.(message, conversation);
	}

	function viewDecoration(message: Message) {
		setContextMenu(null);
		const decoration = (message as any).decoration;
		setDecorationCard({ decoration, anchor: { x: 0, y: 0 } });
	}

	function editMessageRaw(message: Message) {
		// Close the menu before the editor lightbox opens so it doesn't linger
		// on top of / behind the modal.
		setContextMenu(null);
		onEditRaw?.(message);
	}

	function _requestClearConversationMessages() {
		setContextMenu(null);
		setClearMessagesConfirmOpen(true);
	}

	function clearConversationMessagesLocally() {
		if (!conversation) {
			return;
		}

		const next = new Set(messages.map((message) => message.id));
		saveHiddenMessageIds(conversation.id, next);
		setHiddenMessageIds(next);
		setContextMenu(null);
		setUnreadJump(null);
		setClearMessagesConfirmOpen(false);
	}

	function downloadMessageImage(url: string) {
		setContextMenu(null);
		const link = document.createElement("a");
		link.href = url;
		link.download = imageFilenameFromUrl(url);
		link.rel = "noreferrer";
		link.target = "_blank";
		link.click();
	}

	if (!conversation) {
		return (
			<section className={cn("chat-empty")}>
				<img
					className={cn("chat-empty-logo")}
					src={resourceUrl("img", theme === "dark" ? "im_2.jpg" : "im_1.png")}
					alt=""
					draggable={false}
				/>
			</section>
		);
	}

	const showSenderNames = conversation.type !== "direct";
	const currentPreference = {
		...defaultConversationPreference,
		...preference,
	};
	const composerActionRegistry = resolveComposerActionRegistry(composerActions);
	const composerActionContext: ComposerActionContext = {
		conversation,
		blocked: currentPreference.blocked,
		sending,
		closePanels: () => {
			setContextMenu(null);
			setEmojiOpen(false);
			setToolsOpen(false);
		},
	};
	const paneStyle = {
		"--composer-height": `${composerHeight}px`,
		"--desktop-composer-height": `${composerHeight}px`,
		"--mobile-composer-editor-height": `${mobileComposerEditorHeight}px`,
	} as CSSProperties;
	const hasPlusActions = composerActionRegistry.plusPanel.length > 0;

	function runComposerAction(action: ComposerButtonAction) {
		if (isComposerActionDisabled(action, composerActionContext)) {
			return;
		}

		setContextMenu(null);
		void action.onClick?.(composerActionContext);
	}

	return (
		<section
			className={cn(
				"chat-pane",
				conversation.type === "group" ? "with-group-info" : "",
				conversation.type === "group" && groupInfoCollapsed
					? "group-info-collapsed"
					: "",
				mobileComposerLong ? "mobile-composer-long" : "",
				mobileComposerExpanded ? "mobile-composer-expanded-open" : "",
			)}
			style={paneStyle}
		>
			<ChatBackdrop
				imageUrl={backdrop.imageUrl}
				widgetId={backdrop.widgetId}
				opacity={backdrop.opacity}
			/>
			<header className={cn("chat-header")}>
				<button
					className={cn("icon-button back-button")}
					onClick={onBack}
					title="返回"
				>
					<ChevronLeft size={22} />
				</button>
				<div className={cn("chat-title")}>
					<strong>
						<span className={cn("chat-title-text")}>
							{chatHeaderTitle(conversation)}
						</span>
						{isBotConversation(conversation) ? (
							<small
								className={cn("bot-badge")}
								aria-label="机器人"
								title="机器人"
							>
								<Bot size={12} strokeWidth={2.4} />
							</small>
						) : null}
						{conversation.type === "group" && conversation.group.luckyChar ? (
							<img
								className={cn("lucky-char-badge")}
								src={`https://tianquan.gtimg.cn/groupluckyword/item/${conversation.group.luckyChar.id}/pic-${conversation.group.luckyChar.litCount}.png`}
								alt=""
								title={`幸运字符 · 已点亮 ${conversation.group.luckyChar.litCount} 人`}
								referrerPolicy="no-referrer"
							/>
						) : null}
					</strong>
					{conversation.type === "direct" ? (
						<OnlineStatus uid={conversation.otherUser.id} />
					) : null}
				</div>
				<div className={cn("chat-actions")}>
					{onAddMessage &&
					(conversation.type === "group" || conversation.type === "direct") ? (
						<button
							className={cn("icon-button", "group-header-info-action")}
							type="button"
							title="添加消息"
							onClick={() => onAddMessage(conversation)}
						>
							<CirclePlus size={18} />
						</button>
					) : null}
					{onViewDeleted &&
					(conversation.type === "group" || conversation.type === "direct") ? (
						<button
							className={cn("icon-button", "group-header-info-action")}
							type="button"
							title="删除列表"
							onClick={() => onViewDeleted(conversation)}
						>
							<Trash2 size={18} />
						</button>
					) : null}
					{onViewRecalled &&
					(conversation.type === "group" || conversation.type === "direct") ? (
						<button
							className={cn("icon-button", "group-header-info-action")}
							type="button"
							title="撤回列表"
							onClick={() => onViewRecalled(conversation)}
						>
							<RotateCcw size={18} />
						</button>
					) : null}
					{conversation.type === "group" ? (
						<>
							<button
								className={cn("icon-button", "group-header-info-action")}
								type="button"
								title="Group announcements"
								onClick={() => {
									if (conversation?.type === "group") {
										onOpenGroupAnnouncements?.(conversation);
									}
								}}
							>
								<FileText size={18} />
							</button>
							<button
								className={cn("icon-button", "group-header-info-action")}
								type="button"
								title="Group highlights"
								disabled={!hasGroupEssence(conversation)}
								onClick={() => {
									if (conversation?.type === "group") {
										onOpenGroupEssence?.(conversation);
									}
								}}
							>
								<Sparkles size={18} />
							</button>
							<button
								className={cn("icon-button", "group-header-info-action")}
								type="button"
								title="Group albums"
								onClick={() => onOpenGroupAlbums?.(conversation)}
							>
								<Images size={18} />
							</button>
							<button
								className={cn("icon-button", "group-header-info-action")}
								type="button"
								title="Group files"
								onClick={() => onOpenGroupFiles?.(conversation)}
							>
								<FolderOpen size={18} />
							</button>
							<button
								className={cn("icon-button", "group-header-info-action")}
								type="button"
								title="Group analytics"
								onClick={() => onOpenGroupAnalytics?.(conversation)}
							>
								<BarChart3 size={18} />
							</button>
							{onOpenGroupBug && PROJECT_GROUP_IDS.includes(conversation.id) ? (
								<button
									className={cn("icon-button", "group-header-info-action", "group-header-bug-action")}
									type="button"
									title={groupBugOnline ? "反馈 Bug" : "QQ 未在线，暂不可反馈"}
									disabled={!groupBugOnline}
									onClick={() => onOpenGroupBug(conversation)}
								>
									<Bug size={18} />
								</button>
							) : null}
						</>
					) : conversation.type === "direct" ? (
						<button
							className={cn("icon-button", "group-header-info-action")}
							type="button"
							title="私聊分析"
							onClick={() => onOpenBuddyAnalytics?.(conversation)}
						>
							<BarChart3 size={18} />
						</button>
					) : null}
				</div>
			</header>

			<div
				className={cn("message-scroll")}
				ref={messageScrollRef}
				onScroll={handleMessageScroll}
			>
				{loading ? (
					<ChatMessagesSkeleton />
				) : visibleMessages.length === 0 ? (
					<EmptyState title="还没有消息" body="发出第一条消息。" icon={<MessageSquareText />} />
				) : (
					(() => {
						// Detect the gray-tip element (if any) a message carries.
						// 群通话/群课堂的「已结束」（CALL 元素，subType 16/25/29）也走灰条：那条消息的
						// 40020 是空的，谁也不属于，套气泡会凭空多出一个发送者。发起那条有正常
						// 发送人，和私聊的 CALL 一样继续走气泡。
						const GRAY_TIP_KINDS = ['grayTipPoke', 'grayTipRevoke', 'grayTipGroup', 'grayTipXml', 'grayTipFileRecv', 'grayTipTempSession', 'qqDynamic'];
						const grayTipOf = (message) => {
							const els = message.qqElements ?? [];
							for (const kind of GRAY_TIP_KINDS) {
								const el = els.find((e) => e?.type === kind);
								if (el) return { kind, el };
							}
							const callEnded = els.find(
								(e) => e?.type === 'call' && GROUP_CALL_ENDED_SUBTYPES.has(Number(e?.data?.subType)),
							);
							if (callEnded) return { kind: 'groupCallEnded', el: callEnded };
							return null;
						};

						// Render one gray-tip row's inner component (no wrapper).
						const renderGrayTip = (message, gt) => {
							switch (gt.kind) {
								case 'grayTipPoke':
									return <GrayTipPokeMessage element={gt.el} conversation={conversation} message={message} />;
								case 'grayTipRevoke':
									return <GrayTipRevokeMessage element={gt.el} conversation={conversation} message={message} />;
								case 'grayTipGroup':
									return <GrayTipGroupMessage element={gt.el} conversation={conversation} message={message} />;
								case 'grayTipXml':
									return <GrayTipXmlMessage element={gt.el} conversation={conversation} />;
								case 'grayTipFileRecv':
									return <GrayTipFileRecvMessage element={gt.el} />;
								case 'grayTipTempSession':
									return <GrayTipTempSessionMessage element={gt.el} />;
								case 'groupCallEnded':
									return <GroupCallEndedMessage element={gt.el} />;
								case 'qqDynamic': {
									const d = (gt.el.data ?? {}) as Record<string, unknown>;
									return (
										<div className="flex justify-center py-1">
											<QqDynamic
												desc={d.dynamicDesc as { mainDesc?: string; subDesc?: string } | undefined}
												desc2={d.dynamicDesc2 as { mainDesc?: string; subDesc?: string } | undefined}
												coverUrl={d.dynamicCoverUrl as string | undefined}
												zoneLogoUrl={d.dynamicZoneLogoUrl as string | undefined}
											/>
										</div>
									);
								}
								default:
									return null;
							}
						};

						// Gray tips (pokes, recalls, group notices) render as plain
						// centered lines, gathered into runs only so a run can be
						// flushed as a unit when a real message interrupts it.
						const out = [];
						let band = null; // { messages: [{ message, gt }] }
						const flushBand = () => {
							if (!band) return;
							for (const { message, gt } of band.messages) {
								out.push(
									<div
										key={message.id}
										data-message-id={message.id}
										onContextMenu={(e) => openMessageMenu(e, message)}
									>
										{renderGrayTip(message, gt)}
									</div>,
								);
							}
							band = null;
						};

						visibleMessages.forEach((message, index) => {
							// A hole in the seq run means QQ has messages here that were
							// never synced locally. Checked for every row (gray tips
							// included — they occupy a seq too) and emitted before the row
							// that follows the hole.
							const gap = messageGapCount(visibleMessages[index - 1], message);
							if (gap > 0) {
								flushBand();
								const previous = visibleMessages[index - 1];
								out.push(
									<MessageGapDivider
										key={`gap-${message.id}`}
										count={gap}
										onOpen={
											conversation && onOpenGapMessages && previous
												? () =>
														onOpenGapMessages({
															conversation,
															previousSeq: String(previous.msgSeq ?? ''),
															currentSeq: String(message.msgSeq ?? ''),
															count: gap,
														})
												: undefined
										}
									/>,
								);
							}
							const gt = grayTipOf(message);
							if (gt) {
								if (!band) band = { messages: [] };
								band.messages.push({ message, gt });
								return;
							}
							flushBand();
							const previous = visibleMessages[index - 1];
							const mine = message.senderId === user.id;
							const sender = resolveMessageSender(message, conversation, user);
							out.push(
								<Fragment key={message.id}>
									{shouldShowMessageTime(previous, message) ? (
										<MessageTimeDivider value={message.createdAt} />
									) : null}
									<MessageBubble
										message={message}
										conversation={conversation}
										sender={sender}
										mine={mine}
										senderName={displayUserName(sender)}
										senderAvatarUrl={sender.avatarUrl}
										senderSeed={sender.identityValue}
										senderKind={sender.kind}
										showSenderName={showSenderNames}
										active={contextMenu?.message.id === message.id}
										renderers={messageRenderers}
										deleted={deletedIds?.has(message.id) ?? false}
										deletedKind={message.deletedKind}
										recallRevokerName={message.recallRevokerName}
										onRestore={onRestoreMessage}
										onContextMenu={openMessageMenu}
										onLongPress={openMobileMessageMenu}
										onAction={onMessageAction}
										onAvatarClick={
											(conversation.type === "group" || conversation.type === "direct") &&
											onOpenGroupMember
												? onOpenGroupMember
												: undefined
										}
									/>
								</Fragment>,
							);
						});
						flushBand();
						return out;
					})()
				)}
				<div ref={endRef} />
			</div>

			{newMessagePill > 0 ? (
				<button
					className={cn("new-message-pill")}
					type="button"
					onClick={scrollMessagesToBottom}
				>
					<ChevronDown size={14} strokeWidth={2.8} />
					<span>{formatUnreadJumpCount(newMessagePill)}条新消息</span>
				</button>
			) : null}

			{/* biome-ignore lint/correctness/noConstantCondition: 暂时禁用的「跳转首条未读」按钮,保留待恢复 */}
			{false && unreadJump && unreadJump.remaining > 0 ? (
				<button
					className={cn("unread-jump-button")}
					type="button"
					onClick={jumpToFirstUnreadMessage}
				>
					<ChevronsUp size={21} strokeWidth={2.8} />
					<span>{formatUnreadJumpCount(unreadJump.remaining)}条新消息</span>
				</button>
			) : null}

			{conversation.type === "group" ? (
				<>
					<button
						className={cn("group-info-toggle")}
						type="button"
						title={groupInfoCollapsed ? "展开群资料" : "收起群资料"}
						aria-label={groupInfoCollapsed ? "展开群资料" : "收起群资料"}
						aria-expanded={!groupInfoCollapsed}
						onClick={toggleGroupInfoCollapsed}
					>
						{groupInfoCollapsed ? (
							<ChevronLeft size={18} />
						) : (
							<ChevronRight size={18} />
						)}
					</button>
					{!groupInfoCollapsed ? (
						<GroupInfoPanel
							conversation={conversation}
							onOpenDetail={handleOpenGroupInfoDetail}
							onOpenMember={onOpenGroupMember}
							onLoadMoreMembers={onLoadMoreGroupMembers}
							loadingMoreMembers={groupMembersLoading}
							loadingError={groupMembersError}
						/>
					) : null}
				</>
			) : null}

			<div className={cn("composer")}>
				<ComposerResizeHandle
					height={composerHeight}
					onHeightChange={updateComposerHeight}
				/>
				<div className={cn("composer-tools")}>
					{composerActionRegistry.mobileToolbar.map((action) => (
						<ComposerToolbarActionButton
							key={action.id}
							action={action}
							className={cn("composer-tool", "composer-mobile-tool")}
							context={composerActionContext}
							iconSize={27}
							onClick={runComposerAction}
						/>
					))}
					<button
						ref={emojiButtonRef}
						type="button"
						className={cn("composer-tool", emojiOpen && "active")}
						title="表情"
						disabled={currentPreference.blocked}
						onClick={toggleEmojiPanel}
					>
						<Smile size={27} />
					</button>
					{composerActionRegistry.desktopToolbar.map((action) => (
						<ComposerToolbarActionButton
							key={action.id}
							action={action}
							className={cn("composer-tool", "composer-desktop-tool")}
							context={composerActionContext}
							iconSize={27}
							onClick={runComposerAction}
						/>
					))}
					<span />
					{hasPlusActions ? (
						<button
							ref={toolsButtonRef}
							type="button"
							className={cn(
								"composer-tool",
								"composer-mobile-tool",
								toolsOpen && "active",
							)}
							title="更多功能"
							disabled={currentPreference.blocked}
							onClick={toggleToolsPanel}
						>
							<CirclePlus size={28} />
						</button>
					) : null}
				</div>
				{emojiOpen && !mobileComposerExpanded ? (
					<EmojiPanel
						panelRef={emojiPanelRef}
						activePackId={activeEmojiPackId}
						onActivePackChange={setActiveEmojiPackId}
						onSelect={insertEmoji}
					/>
				) : null}
				{toolsOpen && hasPlusActions ? (
					<ComposerPlusPanel
						panelRef={toolsPanelRef}
						actions={composerActionRegistry.plusPanel}
						context={composerActionContext}
						onAction={runComposerAction}
					/>
				) : null}
				{mentionMenu && !mobileComposerExpanded ? (
					<MentionMenu
						menu={mentionMenu}
						menuRef={mentionMenuRef}
						onActiveIndexChange={(activeIndex) =>
							setMentionMenu((current) =>
								current ? { ...current, activeIndex } : current,
							)
						}
						onSelect={insertMention}
					/>
				) : null}
				<div
					ref={composerEditorRef}
					className={cn("composer-editor")}
					role="textbox"
					aria-multiline="true"
					aria-disabled={currentPreference.blocked || sending}
					contentEditable={!currentPreference.blocked && !sending}
					suppressContentEditableWarning
					onInput={() => syncComposerBody(composerEditorRef.current)}
					onKeyDown={handleComposerKeyDown}
					onKeyUp={() => {
						saveComposerSelection(composerEditorRef.current);
						updateMentionMenu(composerEditorRef.current);
					}}
					onMouseUp={() => {
						saveComposerSelection(composerEditorRef.current);
						updateMentionMenu(composerEditorRef.current);
					}}
					onFocus={() => {
						saveComposerSelection(composerEditorRef.current);
						updateMentionMenu(composerEditorRef.current);
					}}
					onBlur={() => saveComposerSelection(composerEditorRef.current)}
					onPaste={handleComposerPaste}
				/>
				<button
					className={cn("mobile-composer-expand-button")}
					type="button"
					title="展开输入"
					aria-label="展开输入"
					onClick={openMobileComposerExpanded}
				>
					<ChevronDown size={22} />
				</button>
			</div>
			{mobileComposerExpanded ? (
				<div className={cn("mobile-composer-expanded")}>
					<section className={cn("mobile-composer-expanded-sheet")}>
						<button
							className={cn("mobile-composer-expanded-close")}
							type="button"
							title="收起输入"
							aria-label="收起输入"
							onClick={closeMobileComposerExpanded}
						>
							<ChevronDown size={27} />
						</button>
						<div
							ref={expandedComposerEditorRef}
							className={cn("composer-editor mobile-composer-expanded-editor")}
							role="textbox"
							aria-multiline="true"
							aria-disabled={currentPreference.blocked || sending}
							contentEditable={!currentPreference.blocked && !sending}
							suppressContentEditableWarning
							onInput={() =>
								syncComposerBody(expandedComposerEditorRef.current)
							}
							onKeyDown={handleComposerKeyDown}
							onKeyUp={() => {
								saveComposerSelection(expandedComposerEditorRef.current);
								updateMentionMenu(expandedComposerEditorRef.current);
							}}
							onMouseUp={() => {
								saveComposerSelection(expandedComposerEditorRef.current);
								updateMentionMenu(expandedComposerEditorRef.current);
							}}
							onFocus={() => {
								saveComposerSelection(expandedComposerEditorRef.current);
								updateMentionMenu(expandedComposerEditorRef.current);
							}}
							onBlur={() =>
								saveComposerSelection(expandedComposerEditorRef.current)
							}
							onPaste={handleComposerPaste}
						/>
						{mentionMenu ? (
							<MentionMenu
								menu={mentionMenu}
								menuRef={mentionMenuRef}
								onActiveIndexChange={(activeIndex) =>
									setMentionMenu((current) =>
										current ? { ...current, activeIndex } : current,
									)
								}
								onSelect={insertMention}
							/>
						) : null}
						<div className={cn("mobile-composer-expanded-tools")}>
							{composerActionRegistry.mobileExpandedToolbar.map((action) => (
								<ComposerToolbarActionButton
									key={action.id}
									action={action}
									context={composerActionContext}
									iconSize={29}
									onClick={runComposerAction}
								/>
							))}
							<button
								ref={expandedEmojiButtonRef}
								type="button"
								title="表情"
								className={cn(emojiOpen && "active")}
								disabled={currentPreference.blocked}
								onClick={toggleEmojiPanel}
							>
								<Smile size={29} />
							</button>
							<span />
							<button
								type="button"
								title="发送"
								disabled={currentPreference.blocked || sending || !body.trim()}
								onClick={() => void submitMessage()}
							>
								<SendHorizontal size={28} />
							</button>
						</div>
						{emojiOpen ? (
							<EmojiPanel
								panelRef={emojiPanelRef}
								activePackId={activeEmojiPackId}
								onActivePackChange={setActiveEmojiPackId}
								onSelect={insertEmoji}
							/>
						) : null}
					</section>
				</div>
			) : null}
			{clearMessagesConfirmOpen ? (
				<ConfirmDialog
					title="确定删除本地聊天记录？"
					onCancel={() => setClearMessagesConfirmOpen(false)}
					onConfirm={clearConversationMessagesLocally}
				/>
			) : null}
			{contextMenu ? (
				<MessageContextMenu
					state={contextMenu}
					onCopy={copyMessage}
					onDownloadImage={downloadMessageImage}
					onDelete={deleteMessage}
					onEditRaw={onEditRaw ? editMessageRaw : undefined}
					onViewDecoration={viewDecoration}
				/>
			) : null}
			{decorationCard ? (
				<MessageDecorationCard
					decoration={decorationCard.decoration}
					onClose={() => setDecorationCard(null)}
				/>
			) : null}
			{groupInfoDetail && conversation.type === "group" ? (
				<GroupInfoDetailDialog
					conversation={conversation}
					detail={groupInfoDetail}
					onClose={() => setGroupInfoDetail(null)}
					onJumpToMessage={(seq) => {
						// 群精华属于群消息，锚点用 seq（与 replyJump 的 group 分支一致）。
						// jumpToSeq 内部会 String(seq) 归一化并处理快路径/翻页/重建窗口。
						setGroupInfoDetail(null);
						if (seq == null) {
							console.warn("[essence-jump] missing msgSeq, cannot jump", seq);
							return;
						}
						jumpToSeq({ seq });
					}}
				/>
			) : null}
		</section>
	);
}

function ConfirmDialog({
	title,
	onCancel,
	onConfirm,
}: {
	title: string;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<div className={cn("confirm-dialog-scrim")} role="presentation">
			<section
				className={cn("confirm-dialog")}
				role="alertdialog"
				aria-modal="true"
				aria-label={title}
			>
				<strong>{title}</strong>
				<div className={cn("confirm-dialog-actions")}>
					<button type="button" onClick={onCancel}>
						取消
					</button>
					<button type="button" onClick={onConfirm}>
						确定
					</button>
				</div>
			</section>
		</div>
	);
}

function ComposerPlusPanel({
	panelRef,
	actions,
	context,
	onAction,
}: {
	panelRef: RefObject<HTMLDivElement | null>;
	actions: ComposerButtonAction[];
	context: ComposerActionContext;
	onAction: (action: ComposerButtonAction) => void;
}) {
	const pageSize = 8;
	const pageCount = Math.ceil(actions.length / pageSize);

	return (
		<div
			className={cn("composer-plus-panel", pageCount <= 1 && "single-page")}
			ref={panelRef}
		>
			<div className={cn("composer-plus-grid")}>
				{actions.map((action) => {
					const Icon = action.icon;
					return (
						<button
							key={action.id}
							type="button"
							title={action.label}
							disabled={isComposerActionDisabled(action, context)}
							onClick={() => onAction(action)}
						>
							<span>
								<Icon size={28} />
							</span>
							<strong>{action.label}</strong>
						</button>
					);
				})}
			</div>
			{pageCount > 1 ? (
				<div className={cn("composer-plus-dots")} aria-hidden="true">
					{Array.from({ length: pageCount }).map((_, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
						<span className={cn(index === 0 && "active")} key={index} />
					))}
				</div>
			) : null}
		</div>
	);
}

function MentionMenu({
	menu,
	menuRef,
	onActiveIndexChange,
	onSelect,
}: {
	menu: MentionMenuState;
	menuRef: RefObject<HTMLDivElement | null>;
	onActiveIndexChange: (activeIndex: number) => void;
	onSelect: (member: GroupMember) => void;
}) {
	return (
		<div className={cn("mention-menu")} ref={menuRef}>
			{menu.members.map((member, index) => (
				<button
					key={member.id}
					type="button"
					className={cn(index === menu.activeIndex && "active")}
					onMouseEnter={() => onActiveIndexChange(index)}
					onMouseDown={(event) => {
						event.preventDefault();
						onSelect(member);
					}}
				>
					<Avatar
						name={displayUserName(member)}
						avatarUrl={member.avatarUrl}
						seed={member.identityValue}
					/>
					<span className={cn("mention-member-name")}>
						{displayUserName(member)}
					</span>
					{member.role !== "member" || member.kind === "bot" ? (
						<span className={cn("mention-member-trailing")}>
							{member.role !== "member" ? (
								<small
									className={cn(
										"mention-role-badge",
										member.role === "owner" ? "owner" : "admin",
									)}
								>
									{member.role === "owner" ? "群主" : "管理"}
								</small>
							) : null}
							{member.kind === "bot" ? (
								<span
									className={cn("bot-badge mention-bot-badge")}
									aria-label="机器人"
									title="机器人"
								>
									<Bot size={12} strokeWidth={2.4} />
								</span>
							) : null}
						</span>
					) : null}
				</button>
			))}
		</div>
	);
}

function ComposerToolbarActionButton({
	action,
	className,
	context,
	iconSize,
	onClick,
}: {
	action: ComposerButtonAction;
	className?: string;
	context: ComposerActionContext;
	iconSize: number;
	onClick: (action: ComposerButtonAction) => void;
}) {
	const Icon = action.icon;

	return (
		<button
			className={className}
			type="button"
			title={action.label}
			disabled={isComposerActionDisabled(action, context)}
			onClick={() => onClick(action)}
		>
			<Icon size={iconSize} />
		</button>
	);
}
