// @ts-nocheck
import type { LucideIcon } from "lucide-react";
import type { Conversation } from "./types";

export type ComposerActionContext = {
	conversation: Conversation;
	blocked: boolean;
	sending: boolean;
	closePanels: () => void;
};

export type ComposerButtonAction = {
	id: string;
	label: string;
	icon: LucideIcon;
	onClick?: (context: ComposerActionContext) => void | Promise<void>;
	disabled?: (context: ComposerActionContext) => boolean;
};

export type ComposerActionRegistry = {
	desktopToolbar: ComposerButtonAction[];
	mobileToolbar: ComposerButtonAction[];
	mobileExpandedToolbar: ComposerButtonAction[];
	plusPanel: ComposerButtonAction[];
};

export type ComposeComposerActionRegistryOptions = {
	base?: ComposerActionRegistry;
	prepend?: Partial<ComposerActionRegistry>;
	append?: Partial<ComposerActionRegistry>;
};

export const defaultComposerActionRegistry: ComposerActionRegistry = {
	desktopToolbar: [],
	mobileToolbar: [],
	mobileExpandedToolbar: [],
	plusPanel: [],
};

export function composeComposerActionRegistry({
	base = defaultComposerActionRegistry,
	prepend = {},
	append = {},
}: ComposeComposerActionRegistryOptions = {}): ComposerActionRegistry {
	return {
		desktopToolbar: [
			...(prepend.desktopToolbar ?? []),
			...base.desktopToolbar,
			...(append.desktopToolbar ?? []),
		],
		mobileToolbar: [
			...(prepend.mobileToolbar ?? []),
			...base.mobileToolbar,
			...(append.mobileToolbar ?? []),
		],
		mobileExpandedToolbar: [
			...(prepend.mobileExpandedToolbar ?? []),
			...base.mobileExpandedToolbar,
			...(append.mobileExpandedToolbar ?? []),
		],
		plusPanel: [
			...(prepend.plusPanel ?? []),
			...base.plusPanel,
			...(append.plusPanel ?? []),
		],
	};
}

export function resolveComposerActionRegistry(
	registry?: Partial<ComposerActionRegistry>,
): ComposerActionRegistry {
	return {
		desktopToolbar:
			registry?.desktopToolbar ?? defaultComposerActionRegistry.desktopToolbar,
		mobileToolbar:
			registry?.mobileToolbar ?? defaultComposerActionRegistry.mobileToolbar,
		mobileExpandedToolbar:
			registry?.mobileExpandedToolbar ??
			defaultComposerActionRegistry.mobileExpandedToolbar,
		plusPanel: registry?.plusPanel ?? defaultComposerActionRegistry.plusPanel,
	};
}

export function isComposerActionDisabled(
	action: ComposerButtonAction,
	context: ComposerActionContext,
) {
	return context.blocked || Boolean(action.disabled?.(context));
}
