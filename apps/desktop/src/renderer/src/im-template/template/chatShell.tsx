// @ts-nocheck
import type { CSSProperties, ReactNode } from "react";
import { cn } from "./classNames";
import { AppRail } from "./rail";
import { SidebarHeader, SidebarResizeHandle } from "./sidebar";
import { TitleBar } from "./TitleBar";
import type {
	ContactNoticeView,
	ContactTab,
	MainView,
	SettingsTab,
	User,
} from "./types";

export function ChatShell({
	user,
	view,
	query,
	contactTab,
	activeNotice,
	sidebarWidth,
	mainOpen,
	messageBadgeCount,
	contactBadgeCount,
	showTools = true,
	railFooterContent,
	friendNoticeCount,
	groupNoticeCount,
	sidebarContent,
	mainContent,
	children,
	onViewChange,
	onOpenSettings,
	onOpenProfile,
	onOpenAbout,
	onOpenHelp,
	onOpenHelp: onOpenHelp_unused, // Not used but kept for interface consistency
	onOpenInvite,
	onQueryChange,
	onQuickInvite,
	onCreateGroup,
	onOpenFriendNotices,
	onOpenGroupNotices,
	onContactTabChange,
	onSidebarWidthChange,
}: {
	user: User;
	view: MainView;
	query: string;
	contactTab: ContactTab;
	activeNotice: ContactNoticeView | null;
	sidebarWidth: number;
	mainOpen: boolean;
	messageBadgeCount: number;
	contactBadgeCount: number;
	showTools?: boolean;
	railFooterContent?: ReactNode;
	friendNoticeCount: number;
	groupNoticeCount: number;
	sidebarContent: ReactNode;
	mainContent: ReactNode;
	children?: ReactNode;
	onViewChange: (view: MainView) => void;
	onOpenSettings: (tab?: SettingsTab) => void;
	onOpenProfile: () => void;
	onOpenAbout: () => void;
	onOpenHelp: () => void;
	onOpenInvite: () => void;
	onQueryChange: (query: string) => void;
	onQuickInvite: () => void;
	onCreateGroup: () => void;
	onOpenFriendNotices: () => void;
	onOpenGroupNotices: () => void;
	onContactTabChange: (tab: ContactTab) => void;
	onSidebarWidthChange: (width: number) => void;
}) {
	const shellStyle = {
		"--sidebar-width": `${sidebarWidth}px`,
	} as CSSProperties;

	return (
		<div className="app-shell-root">
			<TitleBar user={user} />
			<div
				className={cn("app-shell", view === "tools" && "app-shell-tools")}
				style={shellStyle}
			>
				<AppRail
					user={user}
					view={view}
					onViewChange={onViewChange}
					onOpenSettings={onOpenSettings}
					onOpenProfile={onOpenProfile}
					onOpenAbout={onOpenAbout}
					onOpenHelp={onOpenHelp}
					onOpenInvite={onOpenInvite}
					messageBadgeCount={messageBadgeCount}
					contactBadgeCount={contactBadgeCount}
					showTools={showTools}
					footerContent={railFooterContent}
					hideAvatar={true}
				/>
				<aside className={cn("sidebar")}>
					<SidebarHeader
						user={user}
						view={view}
						query={query}
						onQueryChange={onQueryChange}
						onQuickInvite={onQuickInvite}
						onCreateGroup={onCreateGroup}
						onOpenProfile={onOpenProfile}
						onOpenFriendNotices={onOpenFriendNotices}
						onOpenGroupNotices={onOpenGroupNotices}
						contactTab={contactTab}
						onContactTabChange={onContactTabChange}
						activeNotice={activeNotice}
						friendNoticeCount={friendNoticeCount}
						groupNoticeCount={groupNoticeCount}
					/>
					<div className={cn("sidebar-body")}>{sidebarContent}</div>
				</aside>
				<SidebarResizeHandle
					width={sidebarWidth}
					onWidthChange={onSidebarWidthChange}
				/>
				<main className={cn("chat-main", mainOpen && "chat-main-open")}>
					{mainContent}
				</main>
				{children}
			</div>
		</div>
	);
}
