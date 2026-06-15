// @ts-nocheck
import { Bot, ChevronRight, Plus } from "lucide-react";
import { Avatar } from "./primitives";
import type { GroupConversationView } from "./conversationDetailsTypes";
import { displayUserName } from "./user";
import { cn } from "./classNames";

export function GroupInfoPanel({
	conversation,
	onInvite,
}: {
	conversation: GroupConversationView;
	onInvite?: () => void;
}) {
	const announcement = conversation.group.announcement?.trim();

	return (
		<aside className={cn("group-info-panel")} aria-label="群聊资料">
			{announcement ? (
				<section className={cn("group-info-section")}>
					<button className={cn("group-info-heading")} type="button">
						<strong>群公告</strong>
						<ChevronRight size={18} />
					</button>
					<p>{announcement}</p>
				</section>
			) : null}

			<section className={cn("group-info-section")}>
				<header className={cn("group-info-heading group-info-title-row")}>
					<strong>群聊成员 {conversation.group.memberCount}</strong>
					{onInvite ? (
						<button
							className={cn("group-invite-button")}
							type="button"
							title="邀请成员"
							onClick={onInvite}
						>
							<Plus size={15} />
						</button>
					) : null}
				</header>
				<div className={cn("group-info-member-list")}>
					{conversation.members.map((member) => (
						<div className={cn("group-info-member-row")} key={member.id}>
							<Avatar
								name={displayUserName(member)}
								avatarUrl={member.avatarUrl}
								seed={member.identityValue}
							/>
							<span>{displayUserName(member)}</span>
							{member.kind === "bot" ? (
								<small
									className={cn("bot-badge")}
									aria-label="机器人"
									title="机器人"
								>
									<Bot size={12} strokeWidth={2.4} />
								</small>
							) : null}
							{member.role !== "member" ? (
								<small className={cn(`group-role-badge ${member.role}`)}>
									{groupRoleLabel(member.role)}
								</small>
							) : null}
						</div>
					))}
				</div>
			</section>
		</aside>
	);
}

function groupRoleLabel(role: "owner" | "admin" | "member") {
	if (role === "owner") {
		return "群主";
	}
	if (role === "admin") {
		return "管理员";
	}
	return "";
}
