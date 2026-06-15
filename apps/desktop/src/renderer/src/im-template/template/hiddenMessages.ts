// @ts-nocheck
export function loadHiddenMessageIds(conversationId: string | undefined) {
	if (!conversationId) {
		return new Set<string>();
	}

	try {
		const raw = window.localStorage.getItem(
			hiddenMessageStorageKey(conversationId),
		);
		const parsed = raw ? JSON.parse(raw) : [];
		return new Set(
			Array.isArray(parsed)
				? parsed.filter((value) => typeof value === "string")
				: [],
		);
	} catch {
		return new Set<string>();
	}
}

export function saveHiddenMessageIds(conversationId: string, ids: Set<string>) {
	try {
		window.localStorage.setItem(
			hiddenMessageStorageKey(conversationId),
			JSON.stringify([...ids]),
		);
	} catch {
		// Local delete is a convenience feature; storage failures should not break chat.
	}
}

function hiddenMessageStorageKey(conversationId: string) {
	return `chat-template.hiddenMessages.${conversationId}`;
}
