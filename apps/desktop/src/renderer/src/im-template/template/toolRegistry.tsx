// @ts-nocheck
import { FileText, Folder, Gamepad2, Music, Star } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type ToolPaneItem = {
	id: string;
	icon: LucideIcon;
	label: string;
	description?: string;
	color: string;
	onClick?: () => void;
};

export type ToolPaneGroup = {
	id: string;
	label?: string;
	items: ToolPaneItem[];
};

export type ComposeToolRegistryOptions = {
	base?: ToolPaneGroup[];
	prepend?: ToolPaneGroup[];
	append?: ToolPaneGroup[];
};

export const defaultToolRegistry: ToolPaneGroup[] = [
	{
		id: "social",
		label: "常用",
		items: [
			{
				id: "activity",
				icon: Star,
				label: "空间动态",
				description: "查看动态内容",
				color: "#f7c400",
			},
		],
	},
	{
		id: "play",
		label: "娱乐",
		items: [
			{
				id: "games",
				icon: Gamepad2,
				label: "小游戏",
				description: "轻量互动玩法",
				color: "#169cf4",
			},
			{
				id: "music",
				icon: Music,
				label: "音乐",
				description: "音乐和音频入口",
				color: "#62d285",
			},
		],
	},
	{
		id: "files",
		label: "文件",
		items: [
			{
				id: "documents",
				icon: FileText,
				label: "在线文档",
				description: "文档协作入口",
				color: "#347cff",
			},
			{
				id: "file-assistant",
				icon: Folder,
				label: "文件助手",
				description: "管理和整理文件",
				color: "#24b6c9",
			},
		],
	},
];

export function composeToolRegistry({
	base = defaultToolRegistry,
	prepend = [],
	append = [],
}: ComposeToolRegistryOptions = {}): ToolPaneGroup[] {
	return [...prepend, ...base, ...append];
}
