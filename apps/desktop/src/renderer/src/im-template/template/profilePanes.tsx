// @ts-nocheck
import { ChevronLeft, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "./classNames";
import { formatProfileDate } from "./format";
import type { ProfileActionRegistry } from "./profileActions";
import { Avatar, EmptyState } from "./primitives";
import type { Contact, Conversation } from "./types";
import { displayUserName } from "./user";

export function ContactProfilePane({
	contact,
	onBack,
	onMessage,
	profileActions,
}: {
	contact: Contact | undefined;
	onBack: () => void;
	onMessage: (contact: Contact) => void | Promise<void>;
	profileActions?: Partial<ProfileActionRegistry>;
}) {
	if (!contact) {
		return (
			<section className={cn("contact-profile-empty")}>
				<EmptyState title="请选择联系人" body="从联系人列表选择一个人。" />
			</section>
		);
	}
	const profile = contact;

	return (
		<section className={cn("contact-profile-pane")}>
			<button
				className={cn("icon-button contact-profile-back")}
				type="button"
				onClick={onBack}
				title="返回"
			>
				<ChevronLeft size={22} />
			</button>
			<div className={cn("contact-profile-inner")}>
				<header className={cn("contact-profile-head")}>
					<Avatar
						name={displayUserName(profile)}
						avatarUrl={profile.avatarUrl}
						seed={profile.identityValue}
					/>
					<div>
						<strong>{displayUserName(profile)}</strong>
						<span className={cn("copyable-text")}>
							{profile.identityLabel} {profile.identityValue}
						</span>
					</div>
				</header>

				<div className={cn("contact-profile-fields")}>
					<div className={cn("contact-profile-row")}>
						<span>用户名</span>
						<strong>{profile.username}</strong>
					</div>
					{profile.qid ? (
						<div className={cn("contact-profile-row")}>
							<span>QID</span>
							<strong>{profile.qid}</strong>
						</div>
					) : null}
					{profile.categoryName ? (
						<div className={cn("contact-profile-row")}>
							<span>好友分组</span>
							<strong>{profile.categoryName}</strong>
						</div>
					) : null}
					{profile.customStatus || profile.onlineStatus ? (
						<div className={cn("contact-profile-row")}>
							<span>状态</span>
							<strong>{profile.customStatus || profile.onlineStatus}</strong>
						</div>
					) : null}
					{profile.signature ? (
						<div className={cn("contact-profile-row")}>
							<span>签名</span>
							<strong>{profile.signature}</strong>
						</div>
					) : null}
					{profile.age || profile.gender ? (
						<div className={cn("contact-profile-row")}>
							<span>资料</span>
							<strong>
								{[
									profile.age ? `${profile.age} 岁` : null,
									genderLabel(profile.gender),
								]
									.filter(Boolean)
									.join(" · ")}
							</strong>
						</div>
					) : null}
					{profile.intimacy ? (
						<div className={cn("contact-profile-row")}>
							<span>亲密度</span>
							<strong>{profile.intimacy}</strong>
						</div>
					) : null}
					<div className={cn("contact-profile-row")}>
						<span>成为联系人</span>
						<strong>{formatProfileDate(profile.createdAt)}</strong>
					</div>
				</div>
			</div>
		</section>
	);
}

export function GroupProfilePane({
	conversation,
	onBack,
	onMessage,
	profileActions,
}: {
	conversation: Extract<Conversation, { type: "group" }> | undefined;
	onBack: () => void;
	onMessage: (conversationId: string) => void | Promise<void>;
	profileActions?: Partial<ProfileActionRegistry>;
}) {
	const [detailRow, setDetailRow] = useState<{
		label: string;
		value: string;
	} | null>(null);

	useEffect(() => {
		setDetailRow(null);
	}, [conversation?.id]);

	if (!conversation) {
		return (
			<section className={cn("contact-profile-empty")}>
				<EmptyState title="请选择群聊" body="从群聊列表选择一个群。" />
			</section>
		);
	}

	const groupRows = [
		["群公告", conversation.group.announcement?.trim() || "未设置"],
		["我的身份", groupRoleLabel(conversation.group.role)],
		["群成员", `${conversation.group.memberCount} 人`],
		conversation.group.description ? ["群简介", conversation.group.description] : null,
		conversation.group.remark ? ["群备注", conversation.group.remark] : null,
		conversation.group.createTime
			? ["创建时间", formatProfileDate(conversation.group.createTime)]
			: null,
		conversation.group.maxMemberCount
			? [
					"群容量",
					`${conversation.group.memberCount}/${conversation.group.maxMemberCount}`,
				]
			: null,
		conversation.group.entranceQ
			? ["入群问题", conversation.group.entranceQ]
			: null,
	].filter(Boolean) as string[][];

	return (
		<section className={cn("contact-profile-pane group-profile-pane")}>
			<button
				className={cn("icon-button contact-profile-back")}
				type="button"
				onClick={onBack}
				title="返回"
			>
				<ChevronLeft size={22} />
			</button>
			<div className={cn("contact-profile-inner group-profile-inner")}>
				<header className={cn("contact-profile-head group-profile-head")}>
					<Avatar
						name={conversation.group.name}
						avatarUrl={conversation.group.avatarUrl}
						seed={conversation.group.identityValue}
					/>
					<div>
						<strong>{conversation.group.name}</strong>
						<span className={cn("copyable-text")}>
							{conversation.group.identityLabel}{" "}
							{conversation.group.identityValue}
						</span>
					</div>
				</header>

				<div className={cn("contact-profile-fields")}>
					{groupRows.map(([label, value]) => (
						<button
							className={cn(
								"contact-profile-row",
								"group-profile-row-button",
								label === "群公告" && "group-profile-announcement-row",
							)}
							type="button"
							key={label}
							onClick={() => setDetailRow({ label, value })}
						>
							<span>{label}</span>
							<strong>{value}</strong>
						</button>
					))}
				</div>
			</div>
			{detailRow ? (
				<GroupProfileDetailDialog
					title={detailRow.label}
					value={detailRow.value}
					onClose={() => setDetailRow(null)}
				/>
			) : null}
		</section>
	);
}

function GroupProfileDetailDialog({
	title,
	value,
	onClose,
}: {
	title: string;
	value: string;
	onClose: () => void;
}) {
	useEffect(() => {
		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === "Escape") {
				onClose();
			}
		}

		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [onClose]);

	return (
		<div
			className={cn("modal-scrim", "group-profile-detail-scrim")}
			role="presentation"
			onMouseDown={onClose}
		>
			<section
				className={cn("group-profile-detail-dialog")}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				onMouseDown={(event) => event.stopPropagation()}
			>
				<header>
					<strong>{title}</strong>
					<button
						className={cn("icon-button")}
						type="button"
						title="关闭"
						onClick={onClose}
					>
						<X size={18} />
					</button>
				</header>
				<p>{value}</p>
			</section>
		</div>
	);
}

function groupRoleLabel(role: "owner" | "admin" | "member") {
	if (role === "owner") {
		return "群主";
	}
	if (role === "admin") {
		return "管理员";
	}
	return "成员";
}

function genderLabel(value?: number) {
	if (value === 1) {
		return "男";
	}
	if (value === 2) {
		return "女";
	}
	return null;
}
