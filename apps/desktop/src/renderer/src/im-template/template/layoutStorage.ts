// @ts-nocheck
export function loadLayoutNumber(
	key: string,
	fallback: number,
	min: number,
	max: number,
) {
	if (typeof window === "undefined") {
		return fallback;
	}

	try {
		const value = Number(window.localStorage.getItem(key));
		if (!Number.isFinite(value)) {
			return fallback;
		}
		return clamp(value, min, max);
	} catch {
		return fallback;
	}
}

export function saveLayoutNumber(key: string, value: number) {
	try {
		window.localStorage.setItem(key, String(value));
	} catch {
		// Layout persistence is a convenience; storage failures should not block chat.
	}
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}
