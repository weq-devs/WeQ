// @ts-nocheck
import {
	CircleHelp,
	LayoutGrid,
	MessageCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "./classNames";
import { Avatar } from "./primitives";
import type { MainView, SettingsTab, User } from "./types";
import { displayUserName } from "./user";

export function AppRail({
	user,
	view,
	onViewChange,
	onOpenSettings,
	onOpenProfile,
	onOpenAbout,
	onOpenHelp,
	onOpenInvite,
	messageBadgeCount = 0,
	contactBadgeCount = 0,
	showTools = true,
	footerContent,
}: {
	user: User;
	view: MainView;
	onViewChange: (view: MainView) => void;
	onOpenSettings: (tab?: SettingsTab) => void;
	onOpenProfile: () => void;
	onOpenAbout: () => void;
	onOpenHelp: () => void;
	onOpenInvite: () => void;
	messageBadgeCount?: number;
	contactBadgeCount?: number;
	showTools?: boolean;
	footerContent?: ReactNode;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [profileOpen, setProfileOpen] = useState(false);
	const railRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!menuOpen && !profileOpen) {
			return;
		}

		function closeFloating(event: globalThis.MouseEvent) {
			const target = event.target;
			if (!(target instanceof Node)) {
				return;
			}
			if (!railRef.current?.contains(target)) {
				setMenuOpen(false);
				setProfileOpen(false);
			}
		}

		function closeOnEscape(event: globalThis.KeyboardEvent) {
			if (event.key === "Escape") {
				setMenuOpen(false);
				setProfileOpen(false);
			}
		}

		document.addEventListener("mousedown", closeFloating);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("mousedown", closeFloating);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [menuOpen, profileOpen]);

	function openHelp() {
		setMenuOpen(false);
		setProfileOpen(false);
		onOpenHelp();
	}

	function selectView(nextView: MainView) {
		setMenuOpen(false);
		setProfileOpen(false);
		onViewChange(nextView);
	}

	return (
		<aside className={cn("app-rail")} ref={railRef}>
			<button
				className={cn("rail-avatar")}
				title={displayUserName(user)}
				onClick={() => {
					setMenuOpen(false);
					setProfileOpen((open) => !open);
				}}
			>
				<Avatar
					name={displayUserName(user)}
					avatarUrl={user.avatarUrl}
					seed={user.identityValue}
				/>
				<span />
			</button>
			{profileOpen ? (
				<ProfilePopover
					user={user}
					onEditProfile={() => {
						setProfileOpen(false);
						onOpenProfile();
					}}
					onInvite={() => {
						setProfileOpen(false);
						onOpenInvite();
					}}
				/>
			) : null}
			<div className={cn("rail-groups")}>
				<nav className={cn("rail-nav rail-nav-primary")} aria-label="Primary">
					<button
						className={cn(
							railButtonClass(view === "messages"),
							"rail-tab rail-tab-messages",
						)}
						onClick={() => selectView("messages")}
						title="消息"
					>
						<span className={cn("rail-tab-icon")}>
							<MessageCircle size={28} />
						</span>
						<span className={cn("rail-label")}>消息</span>
						{messageBadgeCount > 0 ? (
							<span className={cn("rail-badge")}>
								{formatBadgeCount(messageBadgeCount)}
							</span>
						) : null}
					</button>
					<button
						className={cn(
							railButtonClass(view === "contacts"),
							"rail-tab rail-tab-contacts",
						)}
						onClick={() => selectView("contacts")}
						title="联系人"
					>
						<span className={cn("rail-tab-icon")}>
							<ContactRailIcon />
						</span>
						<span className={cn("rail-label")}>联系人</span>
						{contactBadgeCount > 0 ? (
							<span className={cn("rail-badge")}>
								{formatBadgeCount(contactBadgeCount)}
							</span>
						) : null}
					</button>
					<button
						className={cn(
							railButtonClass(view === "tools"),
							"rail-mobile-tool rail-tab rail-tab-tools",
							!showTools && "rail-desktop-hidden",
						)}
						type="button"
						title="应用"
						onClick={() => selectView("tools")}
					>
						<span className={cn("rail-tab-icon")}>
							<LayoutGrid size={28} />
						</span>
						<span className={cn("rail-label")}>应用</span>
					</button>
				</nav>
			</div>
			<div className={cn("rail-footer")}>
				<button title="帮助" onClick={openHelp}>
					<CircleHelp size={28} />
				</button>
				{footerContent}
			</div>
		</aside>
	);
}

function formatBadgeCount(value: number) {
	return value > 99 ? "99+" : String(value);
}

function railButtonClass(active: boolean) {
	return cn(active && "active");
}

function ContactRailIcon() {
	return (
		<svg className="rail-contact-icon" viewBox="0 0 28 28" aria-hidden="true">
			<circle className="rail-contact-head" cx="14" cy="7.1" r="5.4" />
			<path
				className="rail-contact-body-fill"
				d="M3.8 24.5a10.2 8.2 0 0 1 20.4 0H3.8Z"
			/>
			<path className="rail-contact-collar" d="M10.8 16.8h6.4L14 21.1Z" />
			<path
				className="rail-contact-body-line"
				d="M3.8 24.5a10.2 8.2 0 0 1 20.4 0"
			/>
		</svg>
	);
}

function ProfilePopover({
	user,
	onEditProfile,
	onInvite,
}: {
	user: User;
	onEditProfile: () => void;
	onInvite: () => void;
}) {
	return (
		<section className={cn("profile-popover")}>
			<div className={cn("profile-popover-head")}>
				<Avatar
					name={displayUserName(user)}
					avatarUrl={user.avatarUrl}
					seed={user.identityValue}
				/>
				<div>
					<strong>{displayUserName(user)}</strong>
					<span className={cn("copyable-text")}>
						{user.identityLabel} {user.identityValue}
					</span>
					<em>
						<span />
						在线
					</em>
				</div>
			</div>
			<div className={cn("profile-popover-row")}>
				<span>用户名</span>
				<strong>{user.username}</strong>
			</div>
			<div className={cn("profile-popover-actions")}>
				<button className={cn("secondary-button")} onClick={onEditProfile}>
					编辑资料
				</button>
				<button className={cn("primary-button")} onClick={onInvite}>
					添加联系人
				</button>
			</div>
		</section>
	);
}
