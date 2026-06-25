// @ts-nocheck
import type { Conversation, Message, User } from "./types";
import { displayUserName } from "./user";

export function chatHeaderTitle(conversation: Conversation) {
	if (conversation.type === "group") {
		return `${conversation.group.name} (${conversation.group.memberCount})`;
	}
	const userName = displayUserName(conversation.otherUser);
	const chatType = String(conversation.chatType || '');
	return chatType.includes('TEMPC2CFROMGROUP') ? `${userName} 临时会话` : userName;
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
	// 群聊里 message.sender 已带 customTitle/等级/角色（自己也不例外，见
	// MainView.messageSender 的群分支），优先用它，否则自己的群头衔/等级/角色
	// 会被全局 currentUser（纯账号资料，无这些字段）覆盖掉而不显示。
	if (conversation.type === "group" && message.sender) {
		return message.sender;
	}
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
