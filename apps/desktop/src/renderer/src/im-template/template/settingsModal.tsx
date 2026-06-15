// @ts-nocheck
import {
	Bell,
	BellOff,
	Check,
	ChevronLeft,
	ChevronRight,
	LockKeyhole,
	LogOut,
	MessageSquare,
	Monitor,
	Moon,
	Settings,
	Shield,
	SlidersHorizontal,
	Sun,
	UserRound,
	X,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { closeFromScrim, useEscapeToClose } from "./modalUtils";
import { Avatar } from "./primitives";
import {
	resolveSettingsPanelRegistry,
	type SettingsPanelRegistry,
} from "./settingsPanels";
import type { SettingsTab, User } from "./types";
import type { ThemePreference } from "./theme";
import { cn } from "./classNames";
import { displayUserName } from "./user";

type NotificationMode = "show" | "private" | "off";

export function SettingsModal({
	user,
	initialTab = "general",
	themePreference,
	onThemePreferenceChange,
	onClose,
	onLogout,
	settingsPanels,
}: {
	user: User;
	initialTab?: SettingsTab;
	themePreference: ThemePreference;
	onThemePreferenceChange: (preference: ThemePreference) => void;
	onClose: () => void;
	onLogout?: () => void;
	settingsPanels?: Partial<SettingsPanelRegistry>;
}) {
	const [active, setActive] = useState<string>(initialTab);
	const settingsPanelRegistry = resolveSettingsPanelRegistry(settingsPanels);
	const activeExtensionPanel = settingsPanelRegistry.desktop.find(
		(panel) => panel.id === active,
	);
	const settingsPanelContext = {
		user,
		close: onClose,
	};

	useEscapeToClose(onClose);

	useEffect(() => {
		setActive(initialTab);
	}, [initialTab]);

	return (
		<div
			className={cn("modal-scrim")}
			role="presentation"
			onMouseDown={closeFromScrim(onClose)}
		>
			<section
				className={cn("app-modal settings-modal")}
				role="dialog"
				aria-modal="true"
			>
				<aside className={cn("modal-nav")}>
					<strong>设置</strong>
					<button
						type="button"
						className={cn(active === "general" ? "active" : "")}
						onClick={() => setActive("general")}
					>
						<Settings size={22} />
						通用
					</button>
					<button
						type="button"
						className={cn(active === "notifications" ? "active" : "")}
						onClick={() => setActive("notifications")}
					>
						<Bell size={22} />
						消息通知
					</button>
					<button
						type="button"
						className={cn(active === "account" ? "active" : "")}
						onClick={() => setActive("account")}
					>
						<Shield size={22} />
						账号
					</button>
					{settingsPanelRegistry.desktop.map((panel) => {
						const Icon = panel.icon;
						return (
							<button
								key={panel.id}
								type="button"
								className={cn(active === panel.id ? "active" : "")}
								onClick={() => setActive(panel.id)}
							>
								<Icon size={22} />
								{panel.label}
							</button>
						);
					})}
				</aside>

				<main className={cn("modal-main")}>
					<header className={cn("modal-titlebar")}>
						<div>
							<h2>
								{modalTitle(
									active,
									activeExtensionPanel?.title ?? activeExtensionPanel?.label,
								)}
							</h2>
						</div>
						<button
							className={cn("icon-button")}
							onClick={onClose}
							title="关闭"
						>
							<X size={22} />
						</button>
					</header>

					{active === "general" ? (
						<>
							<section className={cn("modal-card appearance-card")}>
								<h3>外观设置</h3>
								<ThemeSelector
									value={themePreference}
									onChange={onThemePreferenceChange}
								/>
							</section>
							<section className={cn("modal-card")}>
								<h3>聊天</h3>
								<div className={cn("preference-row")}>
									<span>发送消息</span>
									<strong>Enter</strong>
								</div>
								<div className={cn("preference-row")}>
									<span>实时更新</span>
									<strong>由宿主应用接入</strong>
								</div>
								<div className={cn("preference-row")}>
									<span>默认体验</span>
									<strong>会话列表 + 聊天主区</strong>
								</div>
							</section>
						</>
					) : null}

					{active === "notifications" ? <NotificationSettingsPanel /> : null}

					{active === "account" ? (
						<section className={cn("modal-card")}>
							<h3>账号</h3>
							<div className={cn("preference-row")}>
								<span>{user.identityLabel}</span>
								<strong>{user.identityValue}</strong>
							</div>
							<div className={cn("preference-row")}>
								<span>用户名</span>
								<strong>{user.username}</strong>
							</div>
							<button
								className={cn("secondary-button danger-button")}
								onClick={onLogout ?? onClose}
							>
								<LogOut size={18} />
								退出登录
							</button>
						</section>
					) : null}

					{activeExtensionPanel
						? activeExtensionPanel.render(settingsPanelContext)
						: null}
				</main>
			</section>
			<MobileSettingsPage
				user={user}
				themePreference={themePreference}
				onClose={onClose}
				settingsPanels={settingsPanelRegistry}
			/>
		</div>
	);
}

function MobileSettingsPage({
	user,
	themePreference,
	onClose,
	settingsPanels,
}: {
	user: User;
	themePreference: ThemePreference;
	onClose: () => void;
	settingsPanels: SettingsPanelRegistry;
}) {
	const settingsPanelContext = {
		user,
		close: onClose,
	};

	return (
		<section
			className={cn("mobile-settings-page")}
			role="dialog"
			aria-modal="true"
		>
			<header className={cn("mobile-settings-header")}>
				<button
					className={cn("mobile-settings-back")}
					type="button"
					title="返回"
					onClick={onClose}
				>
					<ChevronLeft size={34} strokeWidth={2.4} />
				</button>
				<strong className={cn("mobile-settings-title")}>设置</strong>
				<span />
			</header>

			<main className={cn("mobile-settings-main")}>
				<MobileSettingsCard>
					<MobileSettingsRow
						icon={<UserRound size={29} />}
						label="账号与安全"
						trailing={
							<Avatar
								name={displayUserName(user)}
								avatarUrl={user.avatarUrl}
								seed={user.identityValue}
							/>
						}
					/>
				</MobileSettingsCard>

				<MobileSettingsSection title="功能">
					<MobileSettingsCard>
						<MobileSettingsRow icon={<Bell size={28} />} label="消息通知" />
						<MobileSettingsRow
							icon={<MessageSquare size={28} />}
							label="模式选择"
							value={themePreference === "dark" ? "夜间模式" : "普通模式"}
						/>
						<MobileSettingsRow
							icon={<SlidersHorizontal size={28} />}
							label="通用"
						/>
					</MobileSettingsCard>
				</MobileSettingsSection>

				{settingsPanels.mobile.map((section) => (
					<MobileSettingsSection key={section.id} title={section.title}>
						<MobileSettingsCard>
							{section.rows.map((row) => {
								const Icon = row.icon;
								return (
									<MobileSettingsRow
										key={row.id}
										icon={<Icon size={28} />}
										label={row.label}
										value={row.value}
										onClick={
											row.onClick
												? () => void row.onClick?.(settingsPanelContext)
												: undefined
										}
									/>
								);
							})}
						</MobileSettingsCard>
					</MobileSettingsSection>
				))}

				<MobileSettingsSection title="隐私">
					<MobileSettingsCard>
						<MobileSettingsRow
							icon={<LockKeyhole size={28} />}
							label="隐私设置"
						/>
					</MobileSettingsCard>
				</MobileSettingsSection>
			</main>
		</section>
	);
}

function MobileSettingsSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section className={cn("mobile-settings-section")}>
			<h3 className={cn("mobile-settings-section-title")}>{title}</h3>
			{children}
		</section>
	);
}

function MobileSettingsCard({ children }: { children: ReactNode }) {
	return <section className={cn("mobile-settings-card")}>{children}</section>;
}

function MobileSettingsRow({
	icon,
	label,
	value,
	trailing,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	value?: string;
	trailing?: ReactNode;
	onClick?: () => void;
}) {
	return (
		<button
			className={cn("mobile-settings-row")}
			type="button"
			onClick={onClick}
		>
			<span className={cn("mobile-settings-row-icon")}>{icon}</span>
			<span className={cn("mobile-settings-row-label")}>{label}</span>
			<span className={cn("mobile-settings-row-value")}>
				{trailing ?? value}
			</span>
			<ChevronRight size={28} color="#9b9da3" />
		</button>
	);
}

function modalTitle(active: string, extensionTitle?: string) {
	if (active === "general") {
		return "通用";
	}
	if (active === "account") {
		return "账号";
	}
	if (extensionTitle) {
		return extensionTitle;
	}
	return "消息通知";
}

function ThemeSelector({
	value,
	onChange,
}: {
	value: ThemePreference;
	onChange: (preference: ThemePreference) => void;
}) {
	const options: Array<{
		value: ThemePreference;
		label: string;
		icon: ReactNode;
	}> = [
		{
			value: "light",
			label: "白天模式",
			icon: <Sun size={18} />,
		},
		{
			value: "dark",
			label: "夜间模式",
			icon: <Moon size={18} />,
		},
		{
			value: "system",
			label: "跟随系统",
			icon: <Monitor size={18} />,
		},
	];

	return (
		<div className={cn("theme-grid")} role="radiogroup" aria-label="外观模式">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					className={cn(
						`theme-option ${value === option.value ? "active" : ""}`,
					)}
					role="radio"
					aria-checked={value === option.value}
					onClick={() => onChange(option.value)}
				>
					<span
						className={cn(`theme-preview ${option.value}`)}
						aria-hidden="true"
					>
						<span className={cn("theme-preview-rail")}>
							<span />
							<span />
						</span>
						<span className={cn("theme-preview-list")}>
							<span />
							<span />
						</span>
						<span className={cn("theme-preview-chat")}>
							<span />
							<span />
						</span>
					</span>
					<span className={cn("theme-option-label")}>
						{option.icon}
						<strong>{option.label}</strong>
					</span>
				</button>
			))}
		</div>
	);
}

function NotificationSettingsPanel() {
	const [endpoint, setEndpoint] = useState("");
	const [mode, setMode] = useState<NotificationMode>("show");
	const [status, setStatus] = useState("");

	function save(event: FormEvent) {
		event.preventDefault();
		setStatus("已保存到 demo 状态");
	}

	return (
		<section className={cn("panel-section")}>
			<div className={cn("panel-heading")}>
				<div>
					<span>宿主接入</span>
					<strong>消息通知</strong>
				</div>
				<NotificationBadge mode={mode} configured={Boolean(endpoint.trim())} />
			</div>

			<form className={cn("settings-form")} onSubmit={save}>
				<label>
					<span>通知服务地址</span>
					<input
						value={endpoint}
						onChange={(event) => setEndpoint(event.target.value)}
						placeholder="https://example.com/notify"
					/>
				</label>

				<div className={cn("mode-grid")}>
					<ModeButton
						active={mode === "show"}
						icon={<Bell size={18} />}
						label="显示"
						onClick={() => setMode("show")}
					/>
					<ModeButton
						active={mode === "private"}
						icon={<Shield size={18} />}
						label="私密"
						onClick={() => setMode("private")}
					/>
					<ModeButton
						active={mode === "off"}
						icon={<BellOff size={18} />}
						label="关闭"
						onClick={() => setMode("off")}
					/>
				</div>

				<div className={cn("button-row")}>
					<button className={cn("primary-button")}>
						<Check size={18} />
						保存
					</button>
					<button
						type="button"
						className={cn("secondary-button")}
						onClick={() => setStatus("测试通知已触发 demo 回调")}
					>
						<Bell size={18} />
						测试
					</button>
				</div>

				{status ? <p className={cn("form-status")}>{status}</p> : null}
			</form>
			<button
				className={cn("text-button refresh")}
				onClick={() => setStatus("数据已刷新")}
			>
				刷新数据
			</button>
		</section>
	);
}

function NotificationBadge({
	configured,
	mode,
}: {
	configured: boolean;
	mode: NotificationMode;
}) {
	if (mode === "off") {
		return <span className={cn("status-chip off")}>推送关闭</span>;
	}
	if (!configured) {
		return <span className={cn("status-chip warn")}>未配置</span>;
	}
	if (mode === "private") {
		return <span className={cn("status-chip private")}>私密推送</span>;
	}
	return <span className={cn("status-chip ready")}>已启用</span>;
}

function ModeButton({
	active,
	icon,
	label,
	onClick,
}: {
	active: boolean;
	icon: ReactNode;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={cn(`mode-button ${active ? "active" : ""}`)}
			onClick={onClick}
		>
			{icon}
			{label}
		</button>
	);
}
