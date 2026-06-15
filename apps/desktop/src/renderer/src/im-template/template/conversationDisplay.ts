// @ts-nocheck
import type { Conversation, Message, User } from "./types";
import { displayUserName } from "./user";

export function chatHeaderTitle(conversation: Conversation) {
	return conversation.type === "group"
		? `${conversation.group.name} (${conversation.group.memberCount})`
		: displayUserName(conversation.otherUser);
}

export function isBotConversation(conversation: Conversation) {
	return (
		conversation.type === "direct" && conversation.otherUser.kind === "bot"
	);
}

export function resolveMessageSender(
	message: Message,
	conversation: Conversation,
	currentUser: User,
): User {
	if (message.senderId === currentUser.id) {
		return currentUser;
	}
	if (message.sender) {
		return message.sender;
	}
	if (conversation.type === "group") {
		const member = conversation.members.find(
			(item) => item.id === message.senderId,
		);
		if (member) {
			return member;
		}
	}
	if (conversation.type === "direct") {
		return conversation.otherUser;
	}

	return {
		id: message.senderId,
		identityLabel: "ID",
		identityValue: message.senderId,
		username: "member",
		displayName: "成员",
		avatarUrl: null,
	};
}
