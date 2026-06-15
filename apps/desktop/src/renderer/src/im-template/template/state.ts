// @ts-nocheck
import type { Conversation, ConversationPreferences, Message } from "./types";

export function appendMessage(messages: Message[], message: Message) {
	if (messages.some((current) => current.id === message.id)) {
		return messages;
	}

	return [...messages, message];
}

export function markConversationRead(
	conversations: Conversation[],
	conversationId: string,
) {
	let changed = false;
	const next = conversations.map((conversation) => {
		if (conversation.id !== conversationId || !conversation.unreadCount) {
			return conversation;
		}
		changed = true;
		return {
			...conversation,
			unreadCount: 0,
		};
	});

	return changed ? next : conversations;
}

export function mergeConversationPreferences(
	current: ConversationPreferences,
	conversations: Conversation[],
) {
	const next: ConversationPreferences = {
		...current,
	};

	for (const conversation of conversations) {
		if (conversation.preference) {
			next[conversation.id] = conversation.preference;
		}
	}

	return next;
}
