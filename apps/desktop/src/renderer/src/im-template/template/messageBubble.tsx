// @ts-nocheck
import { useEffect, useRef, useState } from "react";
import type {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import { Bot } from "lucide-react";
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
	onContextMenu,
	onLongPress,
	onAction,
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
	onContextMenu: (event: ReactMouseEvent, message: Message) => void;
	onLongPress: (point: { x: number; y: number }, message: Message) => void;
	onAction?: (message: Message, action: MessageAction) => void | Promise<void>;
}) {
	const longPressTimerRef = useRef<number | null>(null);
	const longPressPointRef = useRef<{ x: number; y: number } | null>(null);
	const longPressAnchorRef = useRef<{ x: number; y: number } | null>(null);
	const bubbleRef = useRef<HTMLDivElement | null>(null);
	const [pendingActionId, setPendingActionId] = useState<string | null>(null);
	const hasCode = parseMarkdownBlocks(message.body).some(
		(block) => block.type === "code",
	);

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

	return (
		<div
			className={cn("message-line", mine ? "mine" : "theirs")}
			data-message-id={message.id}
		>
			{!mine ? (
				<Avatar
					name={senderName}
					avatarUrl={senderAvatarUrl}
					seed={senderSeed}
				/>
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
						{(sender as any).customTitle || (sender as any).levelName ? (
							<small className={cn(
								"member-badge", 
								(sender as any).role,
								(sender as any).levelBracket > 0 ? `level-${(sender as any).levelBracket}` : ""
							)}>
								{(sender as any).memberLevel != null ? `Lv${(sender as any).memberLevel} · ` : ''}{(sender as any).customTitle || (sender as any).levelName}
							</small>
						) : null}
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
