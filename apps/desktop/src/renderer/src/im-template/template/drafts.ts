// @ts-nocheck
import type { ConversationDrafts } from "./types";

const storageKey = "chat-template.conversationDrafts.v1";

export function loadConversationDrafts(): ConversationDrafts {
	return loadConversationDraftsFrom(storageKey);
}

function loadConversationDraftsFrom(key: string): ConversationDrafts {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) {
			return {};
		}

		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}

		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] =>
					typeof entry[0] === "string" && typeof entry[1] === "string",
			),
		);
	} catch {
		return {};
	}
}

export function saveConversationDrafts(drafts: ConversationDrafts) {
	localStorage.setItem(storageKey, JSON.stringify(drafts));
}

export function withConversationDraft(
	drafts: ConversationDrafts,
	conversationId: string,
	value: string,
) {
	const next = { ...drafts };
	if (value.trim()) {
		next[conversationId] = value;
	} else {
		delete next[conversationId];
	}
	saveConversationDrafts(next);
	return next;
}
