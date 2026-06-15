// @ts-nocheck
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { User } from "./types";

export type SettingsPanelContext = {
	user: User;
	close: () => void;
};

export type SettingsPanelEntry = {
	id: string;
	label: string;
	title?: string;
	icon: LucideIcon;
	render: (context: SettingsPanelContext) => ReactNode;
};

export type MobileSettingsPanelRow = {
	id: string;
	label: string;
	icon: LucideIcon;
	value?: string;
	onClick?: (context: SettingsPanelContext) => void | Promise<void>;
};

export type MobileSettingsPanelSection = {
	id: string;
	title: string;
	rows: MobileSettingsPanelRow[];
};

export type SettingsPanelRegistry = {
	desktop: SettingsPanelEntry[];
	mobile: MobileSettingsPanelSection[];
};

export type ComposeSettingsPanelRegistryOptions = {
	base?: SettingsPanelRegistry;
	prepend?: Partial<SettingsPanelRegistry>;
	append?: Partial<SettingsPanelRegistry>;
};

export const defaultSettingsPanelRegistry: SettingsPanelRegistry = {
	desktop: [],
	mobile: [],
};

export function composeSettingsPanelRegistry({
	base = defaultSettingsPanelRegistry,
	prepend = {},
	append = {},
}: ComposeSettingsPanelRegistryOptions = {}): SettingsPanelRegistry {
	return {
		desktop: [
			...(prepend.desktop ?? []),
			...base.desktop,
			...(append.desktop ?? []),
		],
		mobile: [
			...(prepend.mobile ?? []),
			...base.mobile,
			...(append.mobile ?? []),
		],
	};
}

export function resolveSettingsPanelRegistry(
	registry?: Partial<SettingsPanelRegistry>,
): SettingsPanelRegistry {
	return {
		desktop: registry?.desktop ?? defaultSettingsPanelRegistry.desktop,
		mobile: registry?.mobile ?? defaultSettingsPanelRegistry.mobile,
	};
}
