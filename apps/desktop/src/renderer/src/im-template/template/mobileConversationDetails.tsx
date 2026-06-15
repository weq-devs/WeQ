// @ts-nocheck
import { ChevronLeft, ChevronRight, QrCode, UsersRound } from "lucide-react";
import QRCode from "qrcode";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { cn } from "./classNames";
import {
	conversationDetailActionLabel,
	conversationDetailActionValue,
	isConversationDetailActionChecked,
	isConversationDetailActionDisabled,
	resolveConversationDetailActionRegistry,
	type ConversationDetailActionContext,
	type ConversationDetailActionGroup,
	type ConversationDetailActionRegistry,
} from "./conversationDetailActions";
import { Avatar } from "./primitives";
import type { Conversation, ConversationPreference } from "./types";
import { displayUserName } from "./user";

export function MobileConversationDetails({
	conversation,
	preference,
	onClose,
	onPreferenceChange,
	onClearMessages,
	onOpenNotificationSettings,
	conversationDetailActions,
}: {
	conversation: Conversation;
	preference: ConversationPreference;
	onClose: () => void;
	onPreferenceChange: (
		conversationId: string,
		key: keyof ConversationPreference,
		value: boolean,
	) => void;
	onClearMessages: () => void;
	onOpenNotificationSettings: () => void;
	conversationDetailActions?: Partial<ConversationDetailActionRegistry>;
}) {
	function toggle(key: keyof ConversationPreference) {
		onPreferenceChange(conversation.id, key, !preference[key]);
	}
	const actionRegistry = resolveConversationDetailActionRegistry(
		conversationDetailActions,
	);
	const actionContext: ConversationDetailActionContext = {
		conversation,
		preference,
		togglePreference: toggle,
		clearLocalMessages: onClearMessages,
		openNotificationSettings: onOpenNotificationSettings,
	};

	return (
		<section className={cn("mobile-conversation-details")}>
			{conversation.type === "group" ? (
				<MobileGroupDetails
					actionContext={actionContext}
					actionGroups={actionRegistry.groupMobile}
					conversation={conversation}
					onClose={onClose}
				/>
			) : (
				<MobileDirectDetails
					actionContext={actionContext}
					actionGroups={actionRegistry.directMobile}
					conversation={conversation}
					onClose={onClose}
				/>
			)}
		</section>
	);
}

function MobileHeader({
	title,
	onClose,
	trailing,
}: {
	title: string;
	onClose: () => void;
	trailing?: ReactNode;
}) {
	return (
		<header className={cn("mobile-detail-header")}>
			<button
				className={cn("mobile-detail-back")}
				type="button"
				title="返回"
				onClick={onClose}
			>
				<ChevronLeft size={34} strokeWidth={2.4} />
			</button>
			<strong className={cn("mobile-detail-title")}>{title}</strong>
			<div className={cn("mobile-detail-trailing")}>{trailing}</div>
		</header>
	);
}

function MobileDirectDetails({
	actionContext,
	actionGroups,
	conversation,
	onClose,
}: {
	actionContext: ConversationDetailActionContext;
	actionGroups: ConversationDetailActionGroup[];
	conversation: Extract<Conversation, { type: "direct" }>;
	onClose: () => void;
}) {
	const other = conversation.otherUser;
	const [profileOpen, setProfileOpen] = useState(false);

	if (profileOpen) {
		return (
			<MobileDirectProfilePage
				contact={other}
				onBack={() => setProfileOpen(false)}
			/>
		);
	}

	return (
		<>
			<MobileHeader title="聊天设置" onClose={onClose} />
			<main className={cn("mobile-detail-main")}>
				<MobileCard>
					<MobileInfoRow
						icon={
							<Avatar
								name={displayUserName(other)}
								avatarUrl={other.avatarUrl}
								seed={other.identityValue}
							/>
						}
						label={displayUserName(other)}
						onClick={() => setProfileOpen(true)}
					/>
				</MobileCard>

				<MobileDetailActionGroups
					groups={actionGroups}
					context={actionContext}
				/>
			</main>
		</>
	);
}

function MobileGroupDetails({
	actionContext,
	actionGroups,
	conversation,
	onClose,
}: {
	actionContext: ConversationDetailActionContext;
	actionGroups: ConversationDetailActionGroup[];
	conversation: Extract<Conversation, { type: "group" }>;
	onClose: () => void;
}) {
	const members = conversation.members.length > 0 ? conversation.members : [];
	const [qrOpen, setQrOpen] = useState(false);
	const [qrDataUrl, setQrDataUrl] = useState("");
	const qrUrl = groupJoinQrUrl(conversation);

	useEffect(() => {
		if (!qrOpen) {
			return;
		}

		let cancelled = false;
		setQrDataUrl("");
		QRCode.toDataURL(qrUrl, {
			errorCorrectionLevel: "H",
			margin: 1,
			width: 680,
			color: {
				dark: "#4096f5",
				light: "#ffffff",
			},
		})
			.then((dataUrl) => {
				if (!cancelled) {
					setQrDataUrl(dataUrl);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setQrDataUrl("");
				}
			});

		return () => {
			cancelled = true;
		};
	}, [qrOpen, qrUrl]);

	if (qrOpen) {
		return (
			<MobileGroupQrPage
				conversation={conversation}
				qrDataUrl={qrDataUrl}
				qrUrl={qrUrl}
				onBack={() => setQrOpen(false)}
			/>
		);
	}

	return (
		<>
			<MobileHeader title="聊天信息" onClose={onClose} />
			<main className={cn("mobile-detail-main")}>
				<section className={cn("mobile-group-summary")}>
					<Avatar
						name={conversation.group.name}
						avatarUrl={conversation.group.avatarUrl}
						seed={conversation.group.identityValue}
					/>
					<div className={cn("mobile-group-copy")}>
						<strong>{conversation.group.name}</strong>
						<span>
							{conversation.group.identityLabel}:{" "}
							{conversation.group.identityValue}
						</span>
					</div>
					<button
						className={cn("mobile-group-qr-button")}
						type="button"
						title="群二维码"
						onClick={() => setQrOpen(true)}
					>
						<QrCode size={31} />
					</button>
				</section>

				<MobileCard>
					<MobileInfoRow
						icon={<UsersRound size={30} />}
						label="群成员"
						value={`${conversation.group.memberCount}人`}
					/>
					<div className={cn("mobile-member-grid")}>
						{members.slice(0, 15).map((member) => (
							<div className={cn("mobile-member-item")} key={member.id}>
								<Avatar
									name={displayUserName(member)}
									avatarUrl={member.avatarUrl}
									seed={member.identityValue}
								/>
								<span className={cn("mobile-member-name")}>
									{displayUserName(member)}
								</span>
							</div>
						))}
						{members.length === 0 ? (
							<span className={cn("mobile-member-empty")}>暂无成员资料</span>
						) : null}
					</div>
				</MobileCard>

				<MobileCard>
					<MobileInfoRow label="群名称" value={conversation.group.name} />
					<MobileInfoRow label="群备注" value="未设置" />
					<MobileInfoRow
						label="群公告"
						value={conversation.group.announcement?.trim() || "未设置"}
						multiline
					/>
				</MobileCard>

				<MobileDetailActionGroups
					groups={actionGroups}
					context={actionContext}
				/>
			</main>
		</>
	);
}

function MobileDirectProfilePage({
	contact,
	onBack,
}: {
	contact: Conversation["otherUser"];
	onBack: () => void;
}) {
	if (!contact) {
		return null;
	}

	return (
		<>
			<MobileHeader title="个人资料" onClose={onBack} />
			<main className={cn("mobile-detail-main")}>
				<section
					className={cn(
						"mobile-group-summary",
						"mobile-direct-profile-summary",
					)}
				>
					<Avatar
						name={displayUserName(contact)}
						avatarUrl={contact.avatarUrl}
						seed={contact.identityValue}
					/>
					<div className={cn("mobile-group-copy")}>
						<strong>{displayUserName(contact)}</strong>
						<span>
							{contact.identityLabel}: {contact.identityValue}
						</span>
					</div>
					<span />
				</section>

				<MobileCard>
					<MobileInfoRow label="昵称" value={displayUserName(contact)} />
					<MobileInfoRow
						label={contact.identityLabel}
						value={contact.identityValue}
					/>
					<MobileInfoRow label="用户名" value={`@${contact.username}`} />
				</MobileCard>
			</main>
		</>
	);
}

function MobileGroupQrPage({
	conversation,
	qrDataUrl,
	qrUrl,
	onBack,
}: {
	conversation: Extract<Conversation, { type: "group" }>;
	qrDataUrl: string;
	qrUrl: string;
	onBack: () => void;
}) {
	return (
		<section className={cn("mobile-profile-qr-page", "mobile-group-qr-page")}>
			<header className={cn("mobile-profile-qr-header")}>
				<button
					className={cn("mobile-profile-qr-back")}
					type="button"
					title="返回"
					onClick={onBack}
				>
					<ChevronLeft size={34} />
				</button>
				<strong>群二维码</strong>
				<span />
			</header>

			<main className={cn("mobile-profile-qr-main")}>
				<section className={cn("mobile-profile-qr-card")}>
					<div className={cn("mobile-profile-qr-user")}>
						<Avatar
							name={conversation.group.name}
							avatarUrl={conversation.group.avatarUrl}
							seed={conversation.group.identityValue}
						/>
						<div>
							<strong>{conversation.group.name}</strong>
							<span>
								{conversation.group.identityLabel}:{" "}
								{conversation.group.identityValue}
							</span>
						</div>
					</div>
					<div className={cn("mobile-profile-qr-code")}>
						{qrDataUrl ? (
							<img src={qrDataUrl} alt="群二维码" />
						) : (
							<span>生成中</span>
						)}
						{qrDataUrl ? (
							<span className={cn("mobile-profile-qr-logo")}>
								<Avatar
									name={conversation.group.name}
									avatarUrl={conversation.group.avatarUrl}
									seed={conversation.group.identityValue}
								/>
							</span>
						) : null}
					</div>
					<p>扫一扫加入群聊</p>
					<span className={cn("mobile-profile-qr-address")}>{qrUrl}</span>
				</section>
			</main>
		</section>
	);
}

function groupJoinQrUrl(
	conversation: Extract<Conversation, { type: "group" }>,
) {
	const origin =
		typeof window === "undefined"
			? "https://im-template.local"
			: window.location.origin;
	return `${origin}/groups/${encodeURIComponent(conversation.group.identityValue)}/join`;
}

function MobileCard({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("mobile-detail-card", className)}>
			{children}
		</section>
	);
}

function MobileDetailActionGroups({
	groups,
	context,
}: {
	groups: ConversationDetailActionGroup[];
	context: ConversationDetailActionContext;
}) {
	if (groups.length === 0) {
		return null;
	}

	return (
		<>
			{groups.map((group) => (
				<MobileCard key={group.id}>
					{group.actions.map((action) => {
						const Icon = action.icon;
						const icon = Icon ? <Icon size={28} /> : undefined;
						const label = conversationDetailActionLabel(action, context);
						const disabled = isConversationDetailActionDisabled(
							action,
							context,
						);

						if (action.kind === "switch") {
							return (
								<MobileSwitchRow
									checked={isConversationDetailActionChecked(action, context)}
									disabled={disabled}
									icon={icon}
									key={action.id}
									label={label}
									onClick={() => void action.onClick(context)}
								/>
							);
						}

						return (
							<MobileInfoRow
								disabled={disabled}
								icon={icon}
								key={action.id}
								label={label}
								onClick={() => void action.onClick(context)}
								value={conversationDetailActionValue(action, context)}
							/>
						);
					})}
				</MobileCard>
			))}
		</>
	);
}

function MobileInfoRow({
	icon,
	label,
	value,
	onClick,
	labelClassName,
	multiline,
	disabled,
}: {
	icon?: ReactNode;
	label: string;
	value?: string;
	onClick?: () => void;
	labelClassName?: string;
	multiline?: boolean;
	disabled?: boolean;
}) {
	return (
		<button
			className={cn(
				"mobile-detail-row",
				!icon && "mobile-detail-row-no-icon",
				multiline && "mobile-detail-row-multiline",
			)}
			type="button"
			disabled={disabled}
			onClick={onClick}
		>
			{icon ? (
				<span className={cn("mobile-detail-row-icon")}>{icon}</span>
			) : null}
			<span className={cn("mobile-detail-row-label", labelClassName)}>
				{label}
			</span>
			<span
				className={cn(
					"mobile-detail-row-value",
					multiline && "mobile-detail-row-value-multiline",
				)}
			>
				{value}
			</span>
			<ChevronRight size={27} color="#9b9da3" />
		</button>
	);
}

function MobileSwitchRow({
	icon,
	label,
	checked,
	onClick,
	disabled,
}: {
	icon?: ReactNode;
	label: string;
	checked: boolean;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			className={cn(
				"mobile-detail-switch-row",
				!icon && "mobile-detail-switch-row-no-icon",
			)}
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={onClick}
		>
			{icon ? (
				<span className={cn("mobile-detail-switch-icon")}>{icon}</span>
			) : null}
			<span className={cn("mobile-detail-switch-label")}>{label}</span>
			<span className={cn("mobile-detail-switch", checked && "on")}>
				<span />
			</span>
		</button>
	);
}
