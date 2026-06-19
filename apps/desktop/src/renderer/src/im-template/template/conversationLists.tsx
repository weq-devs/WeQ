// @ts-nocheck
import { BellOff, Bot, ChevronRight, PenLine } from "lucide-react";
import { useMemo } from "react";
import { cn } from "./classNames";
import { Avatar, EmptyState } from "./primitives";
import { isBotConversation } from "./conversationDisplay";
import { messageMentionsUser } from "./mentions";
import type {
	Contact,
	Conversation,
	ConversationDrafts,
	ConversationPreferences,
	User,
} from "./types";
import { displayUserName } from "./user";

export function ConversationList({
	conversations,
	activeConversationId,
	preferences,
	drafts,
	query,
	user,
	onSelect,
}: {
	conversations: Conversation[];
	activeConversationId: string | null;
	preferences: ConversationPreferences;
	drafts: ConversationDrafts;
	query: string;
	user?: User;
	onSelect: (conversationId: string) => void;
}) {
	const filtered = useMemo(() => {
		const lower = query.trim().toLowerCase();
		const next = lower
			? conversations.filter((conversation) =>
					conversationSearchText(conversation).includes(lower),
				)
			: conversations;

		return [...next].sort(
			(first, second) =>
				Number(Boolean(preferences[second.id]?.pinned)) -
				Number(Boolean(preferences[first.id]?.pinned)),
		);
	}, [conversations, preferences, query]);

	if (filtered.length === 0) {
		return <EmptyState title="暂无会话" body="从联系人开始一段聊天。" />;
	}

	return (
		<div className={cn("list-stack")}>
			{filtered.map((conversation) => {
				const active = conversation.id === activeConversationId;
				const unreadCount = conversation.unreadCount ?? 0;
				const hasDraft = !active && Boolean(drafts[conversation.id]?.trim());
				const preview = conversationLastMessage(conversation, user);
				const showMentionAlert = unreadCount > 0 && preview.mentionsMe;

				return (
					<button
						key={conversation.id}
						className={cn(listRowClass(active, "conversation-row"))}
						onClick={() => onSelect(conversation.id)}
					>
						<Avatar
							name={conversationTitle(conversation)}
							avatarUrl={conversationAvatarUrl(conversation)}
							seed={conversationSeed(conversation)}
						/>
						<span className={cn("row-main")}>
							<strong>
								<span className={cn("row-title-text")}>
									{conversationTitle(conversation)}
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
							<span className={cn("row-preview-line")}>
								{hasDraft ? (
									<span className={cn("row-draft")}>
										<PenLine size={15} />
										<span className={cn("row-draft-text")}>
											{formatDraftPreview(drafts[conversation.id])}
										</span>
									</span>
								) : (
									<span className={cn("row-message-preview")}>
										{showMentionAlert ? (
											<span className={cn("row-mention-alert")}>[有人@我]</span>
										) : null}
										{preview.text}
									</span>
								)}
								{!unreadCount && preferences[conversation.id]?.muted ? (
									<BellOff className={cn("row-muted")} size={15} />
								) : null}
							</span>
						</span>
						<span className={cn("row-meta")}>
							<span>{formatConversationTime(conversation.updatedAt)}</span>
							{unreadCount ? (
								<span
									className={cn(
										unreadClass(Boolean(preferences[conversation.id]?.muted)),
									)}
								>
									{formatBadgeCount(unreadCount)}
								</span>
							) : null}
						</span>
					</button>
				);
			})}
		</div>
	);
}

export function GroupList({
	conversations,
	activeConversationId,
	query,
	onSelect,
}: {
	conversations: Conversation[];
	activeConversationId: string | null;
	query: string;
	onSelect: (conversationId: string) => void;
}) {
	const groups = useMemo(() => {
		const lower = query.trim().toLowerCase();
		return conversations
			.filter((conversation) => conversation.type === "group")
			.filter(
				(conversation) =>
					!lower || conversationSearchText(conversation).includes(lower),
			);
	}, [conversations, query]);

	if (groups.length === 0) {
		return <EmptyState title="暂无群聊" body="从左上角 + 创建一个群聊。" />;
	}

	return (
		<div className={cn("list-stack")}>
			{groups.map((conversation) => (
				<button
					key={conversation.id}
					className={cn(
						listRowClass(
							conversation.id === activeConversationId,
							"contact-row",
						),
					)}
					onClick={() => onSelect(conversation.id)}
				>
					<Avatar
						name={conversation.group.name}
						avatarUrl={conversation.group.avatarUrl}
						seed={conversation.id}
					/>
					<span className={cn("row-main")}>
						<strong>
							<span className={cn("row-title-text")}>
								{conversation.group.name}
							</span>
						</strong>
						<span>{conversation.group.memberCount} 位成员</span>
					</span>
					<ChevronRight size={22} />
				</button>
			))}
		</div>
	);
}

export function ContactList({
	contacts,
	activeContactId,
	query,
	onSelect,
}: {
	contacts: Contact[];
	activeContactId: string | null;
	query: string;
	onSelect: (contact: Contact) => void;
}) {
	const filtered = useMemo(() => {
		const lower = query.trim().toLowerCase();
		if (!lower) {
			return contacts;
		}
		return contacts.filter((contact) =>
			`${displayUserName(contact)} ${contact.username} ${contact.identityValue}`
				.toLowerCase()
				.includes(lower),
		);
	}, [contacts, query]);

	if (filtered.length === 0) {
		return (
			<EmptyState
				title="暂无联系人"
				body="通过 ID 搜索或邀请链接添加联系人。"
			/>
		);
	}

	return (
		<div className={cn("list-stack")}>
			{filtered.map((contact) => (
				<button
					key={contact.id}
					className={cn(
						listRowClass(contact.id === activeContactId, "contact-row"),
					)}
					onClick={() => onSelect(contact)}
				>
					<Avatar
						name={displayUserName(contact)}
						avatarUrl={contact.avatarUrl}
						seed={contact.identityValue}
					/>
					<span className={cn("row-main")}>
						<strong>
							<span className={cn("row-title-text")}>
								{displayUserName(contact)}
							</span>
							{contact.kind === "bot" ? (
								<small
									className={cn("bot-badge")}
									aria-label="机器人"
									title="机器人"
								>
									<Bot size={12} strokeWidth={2.4} />
								</small>
							) : null}
						</strong>
						<span>
							{contact.categoryName ? `${contact.categoryName} · ` : ""}
							{contact.onlineStatus ? `${contact.onlineStatus} · ` : ""}
							{contact.identityLabel} {contact.identityValue}
						</span>
					</span>
					<ChevronRight size={22} />
				</button>
			))}
		</div>
	);
}

function conversationTitle(conversation: Conversation) {
	return conversation.type === "group"
		? conversation.group.name
		: displayUserName(conversation.otherUser);
}

function conversationAvatarUrl(conversation: Conversation) {
	return conversation.type === "group"
		? conversation.group.avatarUrl
		: conversation.otherUser.avatarUrl;
}

function conversationSeed(conversation: Conversation) {
	return conversation.type === "group"
		? conversation.id
		: conversation.otherUser.identityValue;
}

function conversationLastMessage(conversation: Conversation, user?: User) {
	// When the last message has no text body (e.g. element-only messages like
	// pure image / sticker / file with no preview text), keep the row's
	// preview line empty rather than printing a placeholder — the timestamp
	// and unread-count next to it already convey "there is activity".
	if (!conversation.lastMessage?.body) {
		return {
			text: "",
			mentionsMe: false,
		};
	}

	const mentionsMe =
		conversation.type === "group" &&
		conversation.lastMessage.senderId !== user?.id &&
		messageMentionsUser(conversation.lastMessage.body, user);

	if (
		conversation.type === "group" &&
		conversation.lastMessage.senderDisplayName
	) {
		return {
			text: `${conversation.lastMessage.senderDisplayName}：${conversation.lastMessage.body}`,
			mentionsMe,
		};
	}

	return {
		text: conversation.lastMessage.body,
		mentionsMe,
	};
}

function conversationSearchText(conversation: Conversation) {
	if (conversation.type === "group") {
		return `${conversation.group.name} ${conversation.group.announcement ?? ""} ${conversation.group.description ?? ""} ${conversation.group.remark ?? ""} ${conversation.members.map(displayUserName).join(" ")}`.toLowerCase();
	}

	return `${displayUserName(conversation.otherUser)} ${conversation.otherUser.username} ${conversation.otherUser.identityValue} ${conversation.otherUser.signature ?? ""}`.toLowerCase();
}
function formatConversationTime(value: string | undefined) {
	if (!value) {
		return "";
	}

	const date = new Date(value);
	const now = new Date();
	const todayStart = startOfDay(now).getTime();
	const dateStart = startOfDay(date).getTime();
	const dayDiff = Math.floor((todayStart - dateStart) / 86400000);

	if (dayDiff <= 0) {
		return new Intl.DateTimeFormat("zh-CN", {
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
	}

	if (dayDiff === 1) {
		return "昨天";
	}

	if (dayDiff < 7) {
		return [
			"星期日",
			"星期一",
			"星期二",
			"星期三",
			"星期四",
			"星期五",
			"星期六",
		][date.getDay()];
	}

	return `${date.getFullYear()}/${padDatePart(date.getMonth() + 1)}/${padDatePart(date.getDate())}`;
}

function formatDraftPreview(value: string | undefined) {
	if (!value) {
		return "";
	}

	return value
		.replace(/\[\[chat:emoji:[^\]]+\]\]/g, "[表情]")
		.replace(/\[[^\]\n]{1,32}\]/g, "[表情]")
		.replace(/\s+/g, " ")
		.trim();
}

function startOfDay(value: Date) {
	return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function padDatePart(value: number) {
	return value.toString().padStart(2, "0");
}
function formatBadgeCount(value: number) {
	return value > 99 ? "99+" : String(value);
}

function listRowClass(
	active: boolean,
	semanticClass: "conversation-row" | "contact-row",
) {
	return cn(semanticClass, active && "active");
}

function unreadClass(muted: boolean) {
	return cn("row-unread", muted && "muted");
}
