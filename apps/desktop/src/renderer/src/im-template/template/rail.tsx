// @ts-nocheck
import {
		Bot,
		LayoutGrid,
		MessageCircle,
		Download,
		Settings,
		Hash,
		Star,
		Bookmark,
		HardDrive,
		Store,
		Palette,
		MoreHorizontal,
		Wand2,
		HelpCircle,
		BarChart3,
	} from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { cn } from "./classNames";
import { Avatar } from "./primitives";
import type { MainView, SettingsTab, User } from "./types";
import { displayUserName } from "./user";
import { useUpdateStore } from "../../state/update";

export function AppRail({
	user,
	view,
	onViewChange,
	onOpenSettings,
	onOpenCollection,
	onOpenMarketBrowser,
	onOpenDressUp,
	onOpenProfile,
	onOpenAbout: _onOpenAbout,
	onOpenHelp,
	onOpenInvite,
	onOpenWonderfulTools,
	messageBadgeCount = 0,
	contactBadgeCount = 0,
	showTools = true,
	footerContent,
	hideAvatar = false,
}: {
	user: User;
	view: MainView;
	onViewChange: (view: MainView) => void;
	onOpenSettings: (tab?: SettingsTab) => void;
	onOpenCollection: () => void;
	onOpenMarketBrowser: () => void;
	onOpenDressUp: () => void;
	onOpenProfile: () => void;
	onOpenAbout: () => void;
	onOpenHelp: () => void;
	onOpenInvite: () => void;
	onOpenWonderfulTools: () => void;
	messageBadgeCount?: number;
	contactBadgeCount?: number;
	showTools?: boolean;
	footerContent?: ReactNode;
	hideAvatar?: boolean;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [profileOpen, setProfileOpen] = useState(false);
	const [pendingView, setPendingView] = useState<MainView | null>(null);
	const [, startViewTransition] = useTransition();
	const railRef = useRef<HTMLElement | null>(null);
	const moreRef = useRef<HTMLDivElement | null>(null);
	const activeView = pendingView ?? view;
	const updateAvailable = useUpdateStore((s) => s.available);

	// 「更多功能」里的功能入口（灯箱弹窗 + 帮助对话框）。它们都不是视图
	// （不占 MainView 的 view 位），所以只有 onSelect，没有 active 态。
	const moreItems = [
		{ id: "dressup", label: "个性装扮", icon: Palette, onSelect: onOpenDressUp },
		{ id: "collection", label: "我的收藏", icon: Bookmark, onSelect: onOpenCollection },
		{ id: "market", label: "商城表情", icon: Store, onSelect: onOpenMarketBrowser },
		{ id: "wonderful", label: "妙妙工具", icon: Wand2, onSelect: onOpenWonderfulTools },
		{ id: "help", label: "帮助", icon: HelpCircle, onSelect: onOpenHelp },
	];

	useEffect(() => {
		if (pendingView !== null && view === pendingView) {
			setPendingView(null);
		}
	}, [view, pendingView]);

	useEffect(() => {
		if (!menuOpen && !profileOpen) {
			return;
		}

		function closeFloating(event: globalThis.MouseEvent) {
			const target = event.target;
			if (!(target instanceof Node)) {
				return;
			}
			// 「更多」用自己的容器判定,而不是整条 rail —— 否则点 rail 上别的按钮
			// (设置、导出…)时弹框会留在屏幕上。
			if (!moreRef.current?.contains(target)) {
				setMenuOpen(false);
			}
			if (!railRef.current?.contains(target)) {
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

	function selectView(nextView: MainView) {
		setMenuOpen(false);
		setProfileOpen(false);
		// Paint the active-state change immediately, then push the heavy
		// view switch into a transition so the button animation isn't blocked
		// by downstream rendering work (e.g. loading a large message list).
		setPendingView(nextView);
		startViewTransition(() => {
			onViewChange(nextView);
		});
	}

	return (
		<aside className={cn("app-rail", hideAvatar && "hide-avatar")} ref={railRef}>
			{!hideAvatar && (
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
			)}
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
							railButtonClass(activeView === "messages"),
							"rail-tab rail-tab-messages",
						)}
						onClick={() => selectView("messages")}
						title="消息"
					>
						<span className={cn("rail-tab-icon")}>
							<MessageCircle size={22} strokeWidth={1.5} />
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
							railButtonClass(activeView === "contacts"),
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
							railButtonClass(activeView === "qzone"),
							"rail-tab rail-tab-qzone",
						)}
						onClick={() => selectView("qzone")}
						title="QQ 空间"
						type="button"
					>
						<span className={cn("rail-tab-icon")}>
							<Star size={22} strokeWidth={1.5} />
						</span>
						<span className={cn("rail-label")}>QQ空间</span>
					</button>
					<button
						className={cn(
							railButtonClass(activeView === "channel"),
							"rail-tab rail-tab-channel",
						)}
						onClick={() => selectView("channel")}
						title="QQ 频道"
						type="button"
					>
						<span className={cn("rail-tab-icon")}>
							<Hash size={22} strokeWidth={1.5} />
						</span>
						<span className={cn("rail-label")}>QQ频道</span>
					</button>
					<button
						className={cn(
							railButtonClass(activeView === "export"),
							"rail-tab rail-tab-export",
						)}
						onClick={() => selectView("export")}
						title="导出"
					>
						<span className={cn("rail-tab-icon")}>
							<Download size={22} strokeWidth={1.5} />
						</span>
						<span className={cn("rail-label")}>导出</span>
					</button>
					<button
						className={cn(
							railButtonClass(activeView === "agentlab"),
							"rail-tab rail-tab-agentlab",
						)}
						onClick={() => selectView("agentlab")}
						title="AgentLab"
					>
						<span className={cn("rail-tab-icon")}>
							<Bot size={22} strokeWidth={1.5} />
						</span>
						<span className={cn("rail-label")}>AgentLab</span>
					</button>
					<button
						className={cn(
							railButtonClass(activeView === "cache"),
							"rail-tab rail-tab-cache",
						)}
						onClick={() => selectView("cache")}
						title="本地缓存资源"
					>
						<span className={cn("rail-tab-icon")}>
							<HardDrive size={22} strokeWidth={1.5} />
						</span>
						<span className={cn("rail-label")}>缓存</span>
					</button>
					<button
						className={cn(
							railButtonClass(activeView === "annual"),
							"rail-tab rail-tab-annual",
						)}
						onClick={() => selectView("annual")}
						title="年度报告"
						type="button"
					>
						<span className={cn("rail-tab-icon")}>
							<BarChart3 size={22} strokeWidth={1.5} />
						</span>
						<span className={cn("rail-label")}>年度报告</span>
					</button>
					{/* 相对定位的壳:弹出框要贴在这个按钮右边,而不是整条 rail 的某个固定高度。 */}
					<div className={cn("rail-more-wrap")} ref={moreRef}>
						<button
							className={cn(
								menuOpen && "active",
								"rail-tab rail-tab-more",
							)}
							onClick={() => {
								setProfileOpen(false);
								setMenuOpen((open) => !open);
							}}
							title="更多功能"
							type="button"
							aria-expanded={menuOpen}
						>
							<span className={cn("rail-tab-icon")}>
								<MoreHorizontal size={22} strokeWidth={1.5} />
							</span>
							<span className={cn("rail-label")}>更多</span>
						</button>
						{menuOpen ? (
							<div className={cn("rail-more-popover")} role="menu" aria-label="更多功能">
								{moreItems.map((item) => (
									<button
										key={item.id}
										type="button"
										role="menuitem"
										className={cn("rail-more-tile")}
										title={item.label}
										onClick={() => {
											setMenuOpen(false);
											item.onSelect();
										}}
									>
										<item.icon size={20} strokeWidth={1.6} />
									</button>
								))}
							</div>
						) : null}
					</div>
					<button
						className={cn("rail-tab rail-tab-settings")}
						onClick={() => {
							setMenuOpen(false);
							onOpenSettings();
						}}
						title={updateAvailable ? "设置 · 有新版本可更新" : "设置"}
						type="button"
					>
						<span className={cn("rail-tab-icon")}>
							<Settings size={22} strokeWidth={1.5} />
						</span>
						<span className={cn("rail-label")}>设置</span>
						{updateAvailable ? (
							<span className={cn("rail-badge", "rail-badge-dot")} aria-label="有新版本可更新" />
						) : null}
					</button>
					<button
						className={cn(
							railButtonClass(activeView === "tools"),
							"rail-mobile-tool rail-tab rail-tab-tools",
							!showTools && "rail-desktop-hidden",
						)}
						type="button"
						title="应用"
						onClick={() => selectView("tools")}
					>
						<span className={cn("rail-tab-icon")}>
							<LayoutGrid size={22} strokeWidth={1.5} />
						</span>
						<span className={cn("rail-label")}>应用</span>
					</button>
				</nav>
			</div>
			<div className={cn("rail-footer")}>{footerContent}</div>
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
			<circle className="rail-contact-head" cx="14" cy="7.8" r="4.5" />
			<path
				className="rail-contact-body-fill"
				d="M4.5 24.5a9.5 7.5 0 0 1 19 0H4.5Z"
			/>
			<path className="rail-contact-collar" d="M11.2 17.5h5.6L14 21Z" />
			<path
				className="rail-contact-body-line"
				d="M4.5 24.5a9.5 7.5 0 0 1 19 0"
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
