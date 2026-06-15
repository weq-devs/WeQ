// @ts-nocheck
import { Copy } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Contact, Conversation } from "./types";

type GroupConversation = Extract<Conversation, { type: "group" }>;

export type ProfileActionVariant = "primary" | "secondary";

export type ContactProfileActionContext = {
	contact: Contact;
	copyIdentity: () => Promise<void>;
	message: (contact: Contact) => void | Promise<void>;
};

export type GroupProfileActionContext = {
	conversation: GroupConversation;
	copyIdentity: () => Promise<void>;
	message: (conversationId: string) => void | Promise<void>;
};

export type ProfileAction<TContext> = {
	id: string;
	label: string | ((context: TContext) => string);
	icon?: LucideIcon;
	variant?: ProfileActionVariant;
	disabled?: (context: TContext) => boolean;
	onClick: (context: TContext) => void | Promise<void>;
};

export type ContactProfileAction = ProfileAction<ContactProfileActionContext>;
export type GroupProfileAction = ProfileAction<GroupProfileActionContext>;

export type ProfileActionRegistry = {
	contact: ContactProfileAction[];
	group: GroupProfileAction[];
};

export type ComposeProfileActionRegistryOptions = {
	base?: ProfileActionRegistry;
	prepend?: Partial<ProfileActionRegistry>;
	append?: Partial<ProfileActionRegistry>;
};

export const defaultProfileActionRegistry: ProfileActionRegistry = {
	contact: [
		{
			id: "copy-identity",
			icon: Copy,
			label: (context) => `复制 ${context.contact.identityLabel}`,
			onClick: (context) => context.copyIdentity(),
		},
		{
			id: "message",
			label: "发消息",
			variant: "primary",
			onClick: (context) => context.message(context.contact),
		},
	],
	group: [
		{
			id: "copy-identity",
			icon: Copy,
			label: (context) => `复制${context.conversation.group.identityLabel}`,
			onClick: (context) => context.copyIdentity(),
		},
		{
			id: "message",
			label: "发消息",
			variant: "primary",
			onClick: (context) => context.message(context.conversation.id),
		},
	],
};

export function composeProfileActionRegistry({
	base = defaultProfileActionRegistry,
	prepend = {},
	append = {},
}: ComposeProfileActionRegistryOptions = {}): ProfileActionRegistry {
	return {
		contact: [
			...(prepend.contact ?? []),
			...base.contact,
			...(append.contact ?? []),
		],
		group: [...(prepend.group ?? []), ...base.group, ...(append.group ?? [])],
	};
}

export function resolveProfileActionRegistry(
	registry?: Partial<ProfileActionRegistry>,
): ProfileActionRegistry {
	return {
		contact: registry?.contact ?? defaultProfileActionRegistry.contact,
		group: registry?.group ?? defaultProfileActionRegistry.group,
	};
}

export function profileActionLabel<TContext>(
	action: ProfileAction<TContext>,
	context: TContext,
) {
	return typeof action.label === "function"
		? action.label(context)
		: action.label;
}

export function isProfileActionDisabled<TContext>(
	action: ProfileAction<TContext>,
	context: TContext,
) {
	return Boolean(action.disabled?.(context));
}
