// @ts-nocheck
export function formatProfileDate(value: string) {
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(value));
}
