// @ts-nocheck
import { ChevronRight, Plus, Search, UserPlus, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "./classNames";
import { Avatar } from "./primitives";
import type { ContactTab, MainView, User } from "./types";
import { displayUserName } from "./user";

export function SidebarHeader({
	user,
	view,
	query,
	onQueryChange,
	onQuickInvite,
	onCreateGroup,
	onOpenProfile,
	onOpenFriendNotices,
	onOpenGroupNotices,
	contactTab,
	onContactTabChange,
	activeNotice,
	friendNoticeCount = 0,
	groupNoticeCount = 0,
}: {
	user: User;
	view: MainView;
	query: string;
	onQueryChange: (query: string) => void;
	onQuickInvite: () => void;
	onCreateGroup: () => void;
	onOpenProfile: () => void;
	onOpenFriendNotices: () => void;
	onOpenGroupNotices: () => void;
	contactTab: ContactTab;
	onContactTabChange: (tab: ContactTab) => void;
	activeNotice: "friend" | "group" | null;
	friendNoticeCount?: number;
	groupNoticeCount?: number;
}) {
	const [addOpen, setAddOpen] = useState(false);

	useEffect(() => {
		if (!addOpen) {
			return;
		}

		function closeOnOutside(event: MouseEvent) {
			const target = event.target;
			if (target instanceof Element && target.closest(".sidebar-add-wrap")) {
				return;
			}
			if (target instanceof Node) {
				setAddOpen(false);
			}
		}

		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setAddOpen(false);
			}
		}

		document.addEventListener("mousedown", closeOnOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("mousedown", closeOnOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [addOpen]);

	function handleQuickInvite() {
		setAddOpen(false);
		onQuickInvite();
	}

	function handleCreateGroup() {
		setAddOpen(false);
		onCreateGroup();
	}

	function renderAddMenu() {
		return (
			<div className={cn("sidebar-add-wrap")}>
				<button
					className={cn("sidebar-add", addOpen && "active")}
					title="添加"
					onClick={() => setAddOpen((open) => !open)}
				>
					<Plus size={24} />
				</button>
				{addOpen ? (
					<div className={cn("sidebar-add-menu")}>
						<button type="button" onClick={handleCreateGroup}>
							<UsersRound size={18} />
							<span>创建群聊</span>
						</button>
						<button type="button" onClick={handleQuickInvite}>
							<UserPlus size={18} />
							<span className="desktop-add-friend-label">添加好友/群聊</span>
							<span className="mobile-add-friend-label">加好友/群</span>
						</button>
					</div>
				) : null}
			</div>
		);
	}

	const title =
		view === "contacts"
			? "联系人"
			: view === "tools"
				? "应用"
				: displayUserName(user);

	return (
		<div
			className={cn(
				"sidebar-header",
				view === "contacts" && "sidebar-header-contacts",
			)}
		>
			<div className={cn("mobile-sidebar-top")}>
				<button
					className={cn("mobile-sidebar-avatar")}
					type="button"
					onClick={onOpenProfile}
				>
					<Avatar
						name={displayUserName(user)}
						avatarUrl={user.avatarUrl}
						seed={user.identityValue}
					/>
				</button>
				<div className={cn("mobile-sidebar-title")}>
					<strong>{title}</strong>
					{view === "messages" ? (
						<span>
							<i />
							在线
						</span>
					) : null}
				</div>
				<div className={cn("mobile-sidebar-actions")}>{renderAddMenu()}</div>
			</div>
			<div className={cn("search-row")}>
				<label className={cn("search-box")}>
					<Search size={22} />
					<input
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						placeholder="搜索"
					/>
				</label>
				<div className={cn("desktop-sidebar-add")}>{renderAddMenu()}</div>
			</div>
			{view === "contacts" ? (
				<div className={cn("contact-tools")}>
					<button
						type="button"
						className={cn(contactToolButtonClass(activeNotice === "friend"))}
						onClick={onOpenFriendNotices}
					>
						<span className={cn("notice-entry-label")}>
							<span className={cn("desktop-notice-label")}>好友通知</span>
							<span className={cn("mobile-notice-label")}>新朋友</span>
						</span>
						<ChevronRight size={20} />
					</button>
					<button
						type="button"
						className={cn(contactToolButtonClass(activeNotice === "group"))}
						onClick={onOpenGroupNotices}
					>
						<span className={cn("notice-entry-label")}>
							群通知
						</span>
						<ChevronRight size={20} />
					</button>
					<div
						className={cn("contact-tab-switch")}
						role="tablist"
						aria-label="联系人类型"
					>
						<button
							type="button"
							className={cn(contactTabButtonClass(contactTab === "friends"))}
							onClick={() => onContactTabChange("friends")}
						>
							好友
						</button>
						<button
							type="button"
							className={cn(contactTabButtonClass(contactTab === "groups"))}
							onClick={() => onContactTabChange("groups")}
						>
							群聊
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

function contactToolButtonClass(active: boolean) {
	return cn(active && "active");
}

function contactTabButtonClass(active: boolean) {
	return cn(active && "active");
}
