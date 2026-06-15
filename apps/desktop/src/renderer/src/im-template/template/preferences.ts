// @ts-nocheck
import type { ConversationPreference, ConversationPreferences } from "./types";

export const conversationPreferenceKey =
	"chat-template:conversation-preferences";

export const defaultConversationPreference: ConversationPreference = {
	pinned: false,
	muted: false,
	blocked: false,
};

export function loadConversationPreferences(): ConversationPreferences {
	return loadConversationPreferencesFrom(conversationPreferenceKey);
}

function loadConversationPreferencesFrom(key: string): ConversationPreferences {
	try {
		const stored = window.localStorage.getItem(key);
		if (!stored) {
			return {};
		}

		const parsed = JSON.parse(stored) as ConversationPreferences;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function saveConversationPreferences(
	preferences: ConversationPreferences,
) {
	window.localStorage.setItem(
		conversationPreferenceKey,
		JSON.stringify(preferences),
	);
}
