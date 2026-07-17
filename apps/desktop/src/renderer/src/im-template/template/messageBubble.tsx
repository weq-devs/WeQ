// @ts-nocheck
import { useEffect, useRef, useState } from "react";
import type {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import { Bot, RotateCcw } from "lucide-react";
import { parseMarkdownBlocks } from "./messageMarkdown";
import {
	renderMessageWithRegistry,
	type MessageRenderer,
} from "./messageRenderers";
import { Avatar } from "./primitives";
import type { Conversation, Message, MessageAction, User } from "./types";
import { cn } from "./classNames";
import { SetEmojiReactions } from "../../components/SetEmojiReactions";

export function MessageBubble({
	message,
	conversation,
	sender,
	mine,
	senderName,
	senderAvatarUrl,
	senderSeed,
	senderKind,
	showSenderName,
	active,
	renderers,
	deleted,
	deletedKind,
	recallRevokerName,
	onRestore,
	onContextMenu,
	onLongPress,
	onAction,
	onAvatarClick,
}: {
	message: Message;
	conversation: Conversation;
	sender: User;
	mine: boolean;
	senderName: string;
	senderAvatarUrl: string | null;
	senderSeed: string;
	senderKind?: "human" | "bot";
	showSenderName: boolean;
	active: boolean;
	renderers?: MessageRenderer[];
	/** WeQ-deleted: rendered in place under a translucent overlay + restore-on-hover. */
	deleted?: boolean;
	/**
	 * Deleted origin: `'weq'` (WeQ deleted, restorable) or `'qq'` (QQ-native
	 * recall / delete elsewhere, NOT restorable → "QQ删除" veil, no restore
	 * button). Preferred over the legacy boolean `deleted`.
	 */
	deletedKind?: "weq" | "qq";
	/**
	 * Recall reviser's display name — shown in the 撤回 tag when an admin recalled
	 * someone else's message (`recall.sameSender === false`). Resolved by the
	 * parent from `message.recall.revokeUid`.
	 */
	recallRevokerName?: string;
	/** Restore a WeQ-deleted message (only used when `deleted`). */
	onRestore?: (msgId: string) => Promise<void>;
	onContextMenu: (event: ReactMouseEvent, message: Message) => void;
	onLongPress: (point: { x: number; y: number }, message: Message) => void;
	onAction?: (message: Message, action: MessageAction) => void | Promise<void>;
	onAvatarClick?: (sender: User, anchor: { x: number; y: number }) => void;
}) {
	const longPressTimerRef = useRef<number | null>(null);
	const longPressPointRef = useRef<{ x: number; y: number } | null>(null);
	const longPressAnchorRef = useRef<{ x: number; y: number } | null>(null);
	const bubbleRef = useRef<HTMLDivElement | null>(null);
	const [pendingActionId, setPendingActionId] = useState<string | null>(null);
	const [restoring, setRestoring] = useState(false);
	const hasCode = parseMarkdownBlocks(message.body).some(
		(block) => block.type === "code",
	);
	// Deleted origin — prefer the explicit kind; fall back to the legacy boolean
	// (which always meant a WeQ delete). `qq` = QQ-native recall, not restorable.
	const resolvedKind: "weq" | "qq" | null = deletedKind ?? (deleted ? "weq" : null);
	const isDeleted = resolvedKind !== null;
	const isQqDeleted = resolvedKind === "qq";

	// Recall marker — the anti-recall trigger caught a QQ recall of this message;
	// its content is intact, so we DON'T veil it (unlike delete). We just show a
	// small "撤回" tag below the bubble naming who recalled it. `sameSender` = the
	// author recalled their own message; otherwise an admin recalled someone else's.
	const recall = (message as { recall?: { revokeUid: string; sameSender: boolean; recallTs: number } }).recall;
	const recallText = !recall
		? null
		: recall.sameSender
			? (mine ? "你撤回了这条消息" : "对方撤回了这条消息")
			: `${recallRevokerName?.trim() || "管理员"} 撤回了这条消息`;

	function clearLongPress() {
		if (longPressTimerRef.current !== null) {
			window.clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	}

	function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
		if (event.pointerType === "mouse" || event.button !== 0) {
			return;
		}
		const startPoint = { x: event.clientX, y: event.clientY };
		const rect = event.currentTarget.getBoundingClientRect();
		longPressPointRef.current = startPoint;
		longPressAnchorRef.current = {
			x: rect.left + rect.width / 2,
			y: rect.bottom,
		};
		clearLongPress();
		longPressTimerRef.current = window.setTimeout(() => {
			const anchorPoint = longPressAnchorRef.current ?? startPoint;
			selectMessageContent();
			onLongPress(anchorPoint, message);
			clearLongPress();
		}, 460);
	}

	function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
		const point = longPressPointRef.current;
		if (!point) {
			return;
		}
		if (Math.hypot(event.clientX - point.x, event.clientY - point.y) > 10) {
			clearLongPress();
		}
	}

	function selectMessageContent() {
		const content = bubbleRef.current?.querySelector(".message-content");
		if (!content || !content.textContent?.trim()) {
			return;
		}

		const range = document.createRange();
		range.selectNodeContents(content);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}

	async function handleActionClick(
		event: ReactMouseEvent<HTMLButtonElement>,
		action: MessageAction,
	) {
		event.stopPropagation();
		if (!onAction || pendingActionId) {
			return;
		}

		setPendingActionId(action.id);
		try {
			await onAction(message, action);
		} finally {
			setPendingActionId((current) => (current === action.id ? null : current));
		}
	}

	useEffect(() => clearLongPress, []);

	async function handleRestoreClick(event: ReactMouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
		if (!onRestore || restoring) {
			return;
		}
		setRestoring(true);
		try {
			await onRestore(message.id);
		} finally {
			setRestoring(false);
		}
	}

	return (
		<div
			className={cn("message-line", mine ? "mine" : "theirs", isDeleted && "is-deleted", isQqDeleted && "is-qq-deleted")}
			data-message-id={message.id}
		>
			{!mine ? (
				onAvatarClick ? (
					<button
						type="button"
						className={cn("message-avatar-button")}
						title="查看资料"
						aria-label={`查看 ${senderName} 的资料`}
						onClick={(event) =>
							onAvatarClick(sender, { x: event.clientX, y: event.clientY })
						}
					>
						<Avatar
							name={senderName}
							avatarUrl={senderAvatarUrl}
							seed={senderSeed}
						/>
					</button>
				) : (
					<Avatar
						name={senderName}
						avatarUrl={senderAvatarUrl}
						seed={senderSeed}
					/>
				)
			) : null}
			<div
				ref={bubbleRef}
				className={cn(
					"message-bubble",
					hasCode && "has-code",
					active && "context-active",
				)}
				onContextMenu={(event) => onContextMenu(event, message)}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={clearLongPress}
				onPointerCancel={clearLongPress}
				onPointerLeave={clearLongPress}
				onDragStart={(event) => event.preventDefault()}
			>
				{showSenderName ? (
					<span className={cn("message-name")}>
						{senderName}
						{(() => {
							const role = (sender as any).role;
							const isRoleBadge = role === "owner" || role === "admin";
							// 群头衔优先级：群主/管理员 > 自定义头衔/群等级
							const badgeText = isRoleBadge
								? (role === "owner" ? "群主" : "管理员")
								: ((sender as any).customTitle || (sender as any).levelName);
							if (!badgeText) return null;
							const levelBracket = (sender as any).levelBracket;
							const memberLevel = (sender as any).memberLevel;
							return (
								<small className={cn(
									"member-badge",
									isRoleBadge ? role : "",
									!isRoleBadge && levelBracket > 0 ? `level-${levelBracket}` : ""
								)}>
									{!isRoleBadge && memberLevel != null ? `Lv${memberLevel} · ` : ''}{badgeText}
								</small>
							);
						})()}
						{senderKind === "bot" ? (
							<small
								className={cn("bot-badge")}
								aria-label="机器人"
								title="机器人"
							>
								<Bot size={12} strokeWidth={2.4} />
							</small>
						) : null}
					</span>
				) : null}
				{renderMessageWithRegistry(
					{
						message,
						conversation,
						sender,
						mine,
					},
					renderers,
				)}
				<SetEmojiReactions list={message.setEmojiList} />
				{recallText ? (
					<div className={cn("weq-msg-recall-tag")} title="防撤回已保留原消息">
						<RotateCcw size={12} />
						<span>{recallText}</span>
					</div>
				) : null}
				{isDeleted ? (
					<div className={cn("weq-msg-deleted-veil")} aria-label={isQqDeleted ? "QQ删除的消息" : "已删除的消息"}>
						<span className={cn("weq-msg-deleted-badge")}>{isQqDeleted ? "QQ删除" : "已删除"}</span>
						{!isQqDeleted && onRestore ? (
							<button
								type="button"
								className={cn("weq-msg-restore")}
								title="恢复这条消息"
								disabled={restoring}
								onPointerDown={(event) => event.stopPropagation()}
								onClick={(event) => {
									void handleRestoreClick(event);
								}}
							>
								<RotateCcw size={13} />
								<span>{restoring ? "恢复中…" : "恢复"}</span>
							</button>
						) : null}
					</div>
				) : null}
				{message.actions?.length ? (
					<div className={cn("message-actions")}>
						{message.actions.map((action) => {
							const pending = pendingActionId === action.id;
							return (
								<button
									key={action.id}
									type="button"
									className={cn(
										"message-action-button",
										action.style === "primary" && "primary",
										action.style === "danger" && "danger",
										pending && "pending",
									)}
									aria-busy={pending || undefined}
									disabled={Boolean(pendingActionId)}
									onPointerDown={(event) => event.stopPropagation()}
									onClick={(event) => {
										void handleActionClick(event, action);
									}}
								>
									{action.label}
								</button>
							);
						})}
					</div>
				) : null}
			</div>
			{mine ? (
				<Avatar
					name={senderName}
					avatarUrl={senderAvatarUrl}
					seed={senderSeed}
				/>
			) : null}
		</div>
	);
}
