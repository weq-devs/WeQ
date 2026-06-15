// @ts-nocheck
import { ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "./classNames";
import { copyTextToClipboard } from "./clipboard";
import { formatProfileDate } from "./format";
import {
	isProfileActionDisabled,
	profileActionLabel,
	resolveProfileActionRegistry,
	type ProfileAction,
	type ProfileActionRegistry,
} from "./profileActions";
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
	const [status, setStatus] = useState("");

	useEffect(() => {
		setStatus("");
	}, [contact?.id]);

	if (!contact) {
		return (
			<section className={cn("contact-profile-empty")}>
				<EmptyState title="请选择联系人" body="从联系人列表选择一个人。" />
			</section>
		);
	}
	const profile = contact;

	async function copyUserId() {
		setStatus(
			(await copyTextToClipboard(profile.identityValue))
				? "已复制"
				: "复制失败",
		);
	}
	const actionContext = {
		contact: profile,
		copyIdentity: copyUserId,
		message: onMessage,
	};
	const actions = resolveProfileActionRegistry(profileActions).contact;

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
					<div className={cn("contact-profile-row")}>
						<span>成为联系人</span>
						<strong>{formatProfileDate(profile.createdAt)}</strong>
					</div>
				</div>

				<ProfileActionButtons actions={actions} context={actionContext} />
				{status ? <p className={cn("form-status")}>{status}</p> : null}
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
	const [status, setStatus] = useState("");

	useEffect(() => {
		setStatus("");
	}, [conversation?.id]);

	if (!conversation) {
		return (
			<section className={cn("contact-profile-empty")}>
				<EmptyState title="请选择群聊" body="从群聊列表选择一个群。" />
			</section>
		);
	}

	const groupConversation = conversation;

	async function copyGroupCode() {
		setStatus(
			(await copyTextToClipboard(groupConversation.group.identityValue))
				? "已复制"
				: "复制失败",
		);
	}
	const actionContext = {
		conversation: groupConversation,
		copyIdentity: copyGroupCode,
		message: onMessage,
	};
	const actions = resolveProfileActionRegistry(profileActions).group;

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
					<div className={cn("contact-profile-row")}>
						<span>群公告</span>
						<strong>
							{conversation.group.announcement?.trim() || "未设置"}
						</strong>
					</div>
					<div className={cn("contact-profile-row")}>
						<span>我的身份</span>
						<strong>{groupRoleLabel(conversation.group.role)}</strong>
					</div>
					<div className={cn("contact-profile-row")}>
						<span>群成员</span>
						<strong>{conversation.group.memberCount} 人</strong>
					</div>
				</div>

				<div className={cn("group-profile-members")}>
					{conversation.members.slice(0, 12).map((member) => (
						<Avatar
							key={member.id}
							name={displayUserName(member)}
							avatarUrl={member.avatarUrl}
							seed={member.identityValue}
						/>
					))}
				</div>

				<ProfileActionButtons actions={actions} context={actionContext} />
				{status ? <p className={cn("form-status")}>{status}</p> : null}
			</div>
		</section>
	);
}

function ProfileActionButtons<TContext>({
	actions,
	context,
}: {
	actions: ProfileAction<TContext>[];
	context: TContext;
}) {
	return (
		<div className={cn("contact-profile-actions")}>
			{actions.map((action) => {
				const Icon = action.icon;
				return (
					<button
						key={action.id}
						className={cn(
							action.variant === "primary"
								? "primary-button"
								: "secondary-button",
						)}
						type="button"
						disabled={isProfileActionDisabled(action, context)}
						onClick={() => void action.onClick(context)}
					>
						{Icon ? <Icon size={18} /> : null}
						{profileActionLabel(action, context)}
					</button>
				);
			})}
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
