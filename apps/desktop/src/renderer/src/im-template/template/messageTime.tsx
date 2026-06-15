// @ts-nocheck
import type { Message } from "./types";
import { cn } from "./classNames";

const messageTimeDividerIntervalMs = 5 * 60 * 1000;

export function MessageTimeDivider({ value }: { value: string | undefined }) {
	const label = formatMessageTimeDivider(value);

	if (!label) {
		return null;
	}

	return <time className={cn("message-time-divider")}>{label}</time>;
}

export function shouldShowMessageTime(
	previous: Message | undefined,
	current: Message,
) {
	if (!previous) {
		return true;
	}

	const previousTime = new Date(previous.createdAt).getTime();
	const currentTime = new Date(current.createdAt).getTime();
	if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) {
		return false;
	}

	return currentTime - previousTime >= messageTimeDividerIntervalMs;
}

function formatMessageTimeDivider(value: string | undefined) {
	if (!value) {
		return "";
	}

	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) {
		return "";
	}

	const now = new Date();
	const dateStart = startOfDay(date);
	const todayStart = startOfDay(now);
	const dayDiff = Math.floor(
		(todayStart.getTime() - dateStart.getTime()) / 86400000,
	);
	const time = formatHourMinute(date);

	if (dayDiff <= 0) {
		return time;
	}

	if (dayDiff === 1) {
		return `昨天 ${time}`;
	}

	if (dayDiff > 1 && dayDiff < 7) {
		return `${weekdayName(date)} ${time}`;
	}

	return `${formatYearMonthDay(date)} ${time}`;
}

function formatHourMinute(value: Date) {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		hour12: false,
		minute: "2-digit",
	}).format(value);
}

function weekdayName(value: Date) {
	return new Intl.DateTimeFormat("zh-CN", {
		weekday: "long",
	}).format(value);
}

function formatYearMonthDay(value: Date) {
	const year = value.getFullYear();
	const month = String(value.getMonth() + 1).padStart(2, "0");
	const day = String(value.getDate()).padStart(2, "0");
	return `${year}/${month}/${day}`;
}

function startOfDay(value: Date) {
	return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}
