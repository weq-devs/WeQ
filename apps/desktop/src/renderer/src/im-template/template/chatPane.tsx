// @ts-nocheck
import {
	Bot,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronsUp,
	CirclePlus,
	FileText,
	MessageSquareText,
	SendHorizontal,
	Smile,
	Sparkles,
} from "lucide-react";
import { FaQq } from "react-icons/fa";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { defaultConversationPreference } from "./preferences";
import { Avatar, EmptyState, LoadingState } from "./primitives";
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
import { GrayTipInviteMessage } from '../../components/GrayTipInviteMessage';

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

function hasGroupAnnouncements(conversation: Conversation) {
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
	onSend,
	onMessageAction,
	draft,
	onDraftChange,
	onDraftClear,
	onBack,
	onEditRaw,
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
	onSend: (body: string) => Promise<void>;
	onMessageAction?: (message: Message, action: MessageAction) => Promise<void>;
	draft: string;
	onDraftChange: (conversationId: string, value: string) => void;
	onDraftClear: (conversationId: string) => void;
	onBack: () => void;
	onEditRaw?: (message: Message) => void;
}) {
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
	const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<string>>(
		new Set(),
	);
	const [contextMenu, setContextMenu] =
		useState<MessageContextMenuState | null>(null);
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
	const visibleMessages = messages.filter(
		(message) => !hiddenMessageIds.has(message.id),
	);

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
	}, [conversation?.id, loading, visibleMessages.length]);

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
			scrollMessagesToBottom();
			const frame = window.requestAnimationFrame(scrollMessagesToBottom);
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
			scrollMessagesToBottom();
			const frame = window.requestAnimationFrame(scrollMessagesToBottom);
			return () => window.cancelAnimationFrame(frame);
		}

		// Reading history → surface the pill instead of yanking the view down.
		setNewMessagePill((current) => current + appended);
		return;
	}, [visibleMessages.length, conversation?.id, loading, atLatest]);

	useLayoutEffect(() => {
		if (!unreadJump) {
			return;
		}

		updateUnreadJumpRemaining();
		const frame = window.requestAnimationFrame(updateUnreadJumpRemaining);
		return () => window.cancelAnimationFrame(frame);
	}, [
		unreadJump?.conversationId,
		unreadJump?.total,
		visibleMessages.length,
		loading,
	]);

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
		setBody(draft);
		composerSelectionRef.current = null;
		if (editor) {
			restoreComposer(editor, draft);
			scheduleMobileComposerMeasure(editor);
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

		restoreComposer(editor, body);
		composerSelectionRef.current = null;
		const frame = window.requestAnimationFrame(() => focusComposerEnd(editor));
		return () => window.cancelAnimationFrame(frame);
	}, [mobileComposerExpanded]);

	useEffect(() => {
		if (!contextMenu) {
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
	}, [contextMenu]);

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
		setContextMenu({
			message,
			downloadUrl: getMessageDownloadUrl(message),
			x: Math.min(event.clientX, window.innerWidth - 126),
			y: Math.min(event.clientY, window.innerHeight - 84),
			variant: "desktop",
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
		await copyTextToClipboard(selectedText || message.body);
		setContextMenu(null);
	}

	function deleteMessageLocally(message: Message) {
		if (!conversation) {
			return;
		}

		setHiddenMessageIds((current) => {
			const next = new Set(current);
			next.add(message.id);
			saveHiddenMessageIds(conversation.id, next);
			return next;
		});
		setContextMenu(null);
	}

	function requestClearConversationMessages() {
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
				<div className={cn("chat-empty-container")}>
					<FaQq className={cn("chat-empty-logo")} aria-hidden />
					<p className={cn("chat-empty-text")}>
						左侧选择会话查看聊天记录
					</p>
				</div>
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
					</strong>
					{conversation.type === "direct" ? (
						<OnlineStatus uid={conversation.otherUser.id} />
					) : null}
				</div>
				<div className={cn("chat-actions")}>
					{conversation.type === "group" ? (
						<>
							<button
								className={cn("icon-button", "group-header-info-action")}
								type="button"
								title="Group announcements"
								disabled={!hasGroupAnnouncements(conversation)}
								onClick={() => setGroupInfoDetail("announcements")}
							>
								<FileText size={18} />
							</button>
							<button
								className={cn("icon-button", "group-header-info-action")}
								type="button"
								title="Group highlights"
								disabled={!hasGroupEssence(conversation)}
								onClick={() => setGroupInfoDetail("essence")}
							>
								<Sparkles size={18} />
							</button>
						</>
					) : null}
				</div>
			</header>

			<div
				className={cn("message-scroll")}
				ref={messageScrollRef}
				onScroll={handleMessageScroll}
			>
				{loading ? (
					<LoadingState />
				) : visibleMessages.length === 0 ? (
					<EmptyState title="还没有消息" body="发出第一条消息。" icon={<MessageSquareText />} />
				) : (
					visibleMessages.map((message, index) => {
						const previous = visibleMessages[index - 1];
						const mine = message.senderId === user.id;
						const sender = resolveMessageSender(message, conversation, user);
						const grayTipPokeElement = message.qqElements?.find(
							(e: any) => e.type === 'grayTipPoke'
						);
						if (grayTipPokeElement) {
							return (
								<div
									key={message.id}
									data-message-id={message.id}
									onContextMenu={(e) => openMessageMenu(e, message)}
								>
									<GrayTipPokeMessage
										element={grayTipPokeElement}
										conversation={conversation}
										message={message}
									/>
								</div>
							);
						}
						const grayTipRevokeElement = message.qqElements?.find(
							(e: any) => e.type === 'grayTipRevoke'
						);
						if (grayTipRevokeElement) {
							return (
								<div
									key={message.id}
									data-message-id={message.id}
									onContextMenu={(e) => openMessageMenu(e, message)}
								>
									<GrayTipRevokeMessage
										element={grayTipRevokeElement}
									/>
								</div>
							);
						}
						const grayTipGroupElement = message.qqElements?.find(
							(e: any) => e.type === 'grayTipGroup'
						);
						if (grayTipGroupElement) {
							return (
								<div
									key={message.id}
									data-message-id={message.id}
									onContextMenu={(e) => openMessageMenu(e, message)}
								>
									<GrayTipGroupMessage
										element={grayTipGroupElement}
										conversation={conversation}
										message={message}
									/>
								</div>
							);
						}
						const grayTipInviteElement = message.qqElements?.find(
							(e: any) => e.type === 'grayTipInvite'
						);
						if (grayTipInviteElement) {
							return (
								<div
									key={message.id}
									data-message-id={message.id}
									onContextMenu={(e) => openMessageMenu(e, message)}
								>
									<GrayTipInviteMessage
										element={grayTipInviteElement}
										conversation={conversation}
									/>
								</div>
							);
						}
						return (
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
									onContextMenu={openMessageMenu}
									onLongPress={openMobileMessageMenu}
									onAction={onMessageAction}
								/>
							</Fragment>
						);
					})
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
							onOpenDetail={setGroupInfoDetail}
							onLoadMoreMembers={onLoadMoreGroupMembers}
							loadingMoreMembers={groupMembersLoading}
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
					onDeleteLocal={deleteMessageLocally}
					onEditRaw={onEditRaw}
				/>
			) : null}
			{groupInfoDetail && conversation.type === "group" ? (
				<GroupInfoDetailDialog
					conversation={conversation}
					detail={groupInfoDetail}
					onClose={() => setGroupInfoDetail(null)}
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
