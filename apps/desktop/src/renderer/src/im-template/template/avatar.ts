// @ts-nocheck
export type AvatarSource = "github" | "weavatar";

export function resolveAvatarUrl(source: AvatarSource, value: string) {
	const input = value.trim();
	if (!input) {
		return null;
	}

	if (source === "github") {
		return githubAvatarUrl(input);
	}

	return weAvatarUrl(input);
}

export function avatarSourceLabel(source: AvatarSource) {
	if (source === "github") {
		return "GitHub 用户名";
	}
	return "MD5";
}

export function avatarSourcePlaceholder(source: AvatarSource) {
	if (source === "github") {
		return "github";
	}
	return "32 位 MD5";
}

export function avatarSourceError(source: AvatarSource) {
	if (source === "github") {
		return "请输入有效 GitHub 用户名";
	}
	return "请输入 32 位 MD5";
}

export function avatarInputFromUrl(value: string | null): {
	source: AvatarSource;
	value: string;
} {
	if (!value) {
		return { source: "github", value: "" };
	}

	const github = value.match(
		/^https:\/\/github\.com\/([a-zA-Z0-9-]+)\.png\?size=240$/,
	);
	if (github?.[1]) {
		return { source: "github", value: github[1] };
	}

	const githubAvatar = value.match(
		/^https:\/\/avatars\.githubusercontent\.com\/([a-zA-Z0-9-]+)\?s=240$/,
	);
	if (githubAvatar?.[1]) {
		return { source: "github", value: githubAvatar[1] };
	}

	const weavatar = value.match(
		/^https:\/\/weavatar\.com\/avatar\/([a-fA-F0-9]{32})\?s=240&d=letter$/,
	);
	if (weavatar?.[1]) {
		return { source: "weavatar", value: weavatar[1].toLowerCase() };
	}

	return { source: "github", value: "" };
}

function githubAvatarUrl(username: string) {
	if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username)) {
		return null;
	}

	return `https://avatars.githubusercontent.com/${username.toLowerCase()}?s=240`;
}

function weAvatarUrl(value: string) {
	const input = value.trim().toLowerCase();
	if (!/^[a-f0-9]{32}$/.test(input)) {
		return null;
	}

	return `https://weavatar.com/avatar/${input}?s=240&d=letter`;
}
