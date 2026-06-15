// @ts-nocheck
import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const themePreferenceStorageKey = "chat-template.theme";

export function useThemePreference() {
	const [preference, setPreference] =
		useState<ThemePreference>(loadThemePreference);

	useEffect(() => {
		applyThemePreference(preference);
		saveThemePreference(preference);

		if (preference !== "system") {
			return;
		}

		const media = window.matchMedia("(prefers-color-scheme: dark)");
		function handleSystemThemeChange() {
			applyThemePreference("system");
		}

		media.addEventListener("change", handleSystemThemeChange);
		return () => media.removeEventListener("change", handleSystemThemeChange);
	}, [preference]);

	return [preference, setPreference] as const;
}

function loadThemePreference(): ThemePreference {
	try {
		const value = window.localStorage.getItem(themePreferenceStorageKey);
		return isThemePreference(value) ? value : "system";
	} catch {
		return "system";
	}
}

function saveThemePreference(preference: ThemePreference) {
	try {
		window.localStorage.setItem(themePreferenceStorageKey, preference);
	} catch {
		// localStorage can be unavailable in private or embedded contexts.
	}
}

function applyThemePreference(preference: ThemePreference) {
	const resolved = resolveThemePreference(preference);
	document.documentElement.dataset.themePreference = preference;
	document.documentElement.dataset.theme = resolved;
	document.documentElement.style.colorScheme = resolved;
}

function resolveThemePreference(preference: ThemePreference) {
	if (preference === "system") {
		return window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	}

	return preference;
}

function isThemePreference(value: string | null): value is ThemePreference {
	return value === "system" || value === "light" || value === "dark";
}
