// @ts-nocheck
import { Bell, BellOff, Pin, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Conversation, ConversationPreference } from "./types";

export type ConversationDetailActionKind = "row" | "switch";
export type ConversationDetailActionGroupVariant = "card" | "standalone";

export type ConversationDetailActionContext = {
	conversation: Conversation;
	preference: ConversationPreference;
	togglePreference: (key: keyof ConversationPreference) => void;
	clearLocalMessages: () => void;
	openNotificationSettings: () => void;
};

export type ConversationDetailAction = {
	id: string;
	kind: ConversationDetailActionKind;
	label: string | ((context: ConversationDetailActionContext) => string);
	value?:
		| string
		| ((context: ConversationDetailActionContext) => string | undefined);
	icon?: LucideIcon;
	checked?: (context: ConversationDetailActionContext) => boolean;
	disabled?: (context: ConversationDetailActionContext) => boolean;
	onClick: (context: ConversationDetailActionContext) => void | Promise<void>;
};

export type ConversationDetailActionGroup = {
	id: string;
	variant?: ConversationDetailActionGroupVariant;
	actions: ConversationDetailAction[];
};

export type ConversationDetailActionRegistry = {
	directDesktop: ConversationDetailActionGroup[];
	groupDesktop: ConversationDetailActionGroup[];
	directMobile: ConversationDetailActionGroup[];
	groupMobile: ConversationDetailActionGroup[];
};

export type ComposeConversationDetailActionRegistryOptions = {
	base?: ConversationDetailActionRegistry;
	prepend?: Partial<ConversationDetailActionRegistry>;
	append?: Partial<ConversationDetailActionRegistry>;
};

const pinnedAction: ConversationDetailAction = {
	id: "pinned",
	icon: Pin,
	kind: "switch",
	label: "设为置顶",
	checked: (context) => context.preference.pinned,
	onClick: (context) => context.togglePreference("pinned"),
};

const mutedAction: ConversationDetailAction = {
	id: "muted",
	icon: BellOff,
	kind: "switch",
	label: "消息免打扰",
	checked: (context) => context.preference.muted,
	onClick: (context) => context.togglePreference("muted"),
};

const blockedAction: ConversationDetailAction = {
	id: "blocked",
	kind: "switch",
	label: "屏蔽此人",
	checked: (context) => context.preference.blocked,
	onClick: (context) => context.togglePreference("blocked"),
};

const notificationAction: ConversationDetailAction = {
	id: "notification-settings",
	icon: Bell,
	kind: "row",
	label: "消息通知设置",
	value: "消息预览、提示音等",
	onClick: (context) => context.openNotificationSettings(),
};

const clearMessagesAction: ConversationDetailAction = {
	id: "clear-messages",
	icon: Trash2,
	kind: "row",
	label: "删除聊天记录",
	value: "仅清空本地显示",
	onClick: (context) => context.clearLocalMessages(),
};

const clearMessagesMobileAction: ConversationDetailAction = {
	id: "clear-messages",
	kind: "row",
	label: "删除聊天记录",
	onClick: (context) => context.clearLocalMessages(),
};

export const defaultConversationDetailActionRegistry: ConversationDetailActionRegistry =
	{
		directDesktop: [
			{
				id: "preferences",
				actions: [pinnedAction, mutedAction],
			},
			{
				id: "safety",
				actions: [blockedAction],
			},
			{
				id: "history",
				actions: [clearMessagesAction],
			},
			{
				id: "notifications",
				variant: "standalone",
				actions: [notificationAction],
			},
		],
		groupDesktop: [
			{
				id: "preferences",
				actions: [pinnedAction, mutedAction],
			},
			{
				id: "notifications",
				variant: "standalone",
				actions: [notificationAction],
			},
			{
				id: "history",
				actions: [clearMessagesAction],
			},
		],
		directMobile: [
			{
				id: "preferences",
				actions: [pinnedAction, mutedAction, notificationAction],
			},
			{
				id: "history",
				actions: [clearMessagesMobileAction],
			},
		],
		groupMobile: [
			{
				id: "history",
				actions: [clearMessagesMobileAction],
			},
		],
	};

export function composeConversationDetailActionRegistry({
	base = defaultConversationDetailActionRegistry,
	prepend = {},
	append = {},
}: ComposeConversationDetailActionRegistryOptions = {}): ConversationDetailActionRegistry {
	return {
		directDesktop: [
			...(prepend.directDesktop ?? []),
			...base.directDesktop,
			...(append.directDesktop ?? []),
		],
		groupDesktop: [
			...(prepend.groupDesktop ?? []),
			...base.groupDesktop,
			...(append.groupDesktop ?? []),
		],
		directMobile: [
			...(prepend.directMobile ?? []),
			...base.directMobile,
			...(append.directMobile ?? []),
		],
		groupMobile: [
			...(prepend.groupMobile ?? []),
			...base.groupMobile,
			...(append.groupMobile ?? []),
		],
	};
}

export function resolveConversationDetailActionRegistry(
	registry?: Partial<ConversationDetailActionRegistry>,
): ConversationDetailActionRegistry {
	return {
		directDesktop:
			registry?.directDesktop ??
			defaultConversationDetailActionRegistry.directDesktop,
		groupDesktop:
			registry?.groupDesktop ??
			defaultConversationDetailActionRegistry.groupDesktop,
		directMobile:
			registry?.directMobile ??
			defaultConversationDetailActionRegistry.directMobile,
		groupMobile:
			registry?.groupMobile ??
			defaultConversationDetailActionRegistry.groupMobile,
	};
}

export function conversationDetailActionLabel(
	action: ConversationDetailAction,
	context: ConversationDetailActionContext,
) {
	return typeof action.label === "function"
		? action.label(context)
		: action.label;
}

export function conversationDetailActionValue(
	action: ConversationDetailAction,
	context: ConversationDetailActionContext,
) {
	return typeof action.value === "function"
		? action.value(context)
		: action.value;
}

export function isConversationDetailActionChecked(
	action: ConversationDetailAction,
	context: ConversationDetailActionContext,
) {
	return Boolean(action.checked?.(context));
}

export function isConversationDetailActionDisabled(
	action: ConversationDetailAction,
	context: ConversationDetailActionContext,
) {
	return Boolean(action.disabled?.(context));
}
