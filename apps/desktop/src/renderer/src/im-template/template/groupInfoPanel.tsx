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
	const ANNOUNCEMENT_MAX = 120;
	const rawAnnouncement = conversation.group.announcement?.trim();
	const announcement =
		rawAnnouncement && rawAnnouncement.length > ANNOUNCEMENT_MAX
			? `${rawAnnouncement.slice(0, ANNOUNCEMENT_MAX)}…`
			: rawAnnouncement;

	return (
		<aside className={cn("group-info-panel")} aria-label="群聊资料">
			<section className={cn("group-info-section")}>
				<header className={cn("group-info-heading")}>
					<strong>群公告</strong>
					<ChevronRight size={18} />
				</header>
				<div className={cn("group-announcement-content", !announcement && "is-empty")}>
					{announcement ? (
						<p>{announcement}</p>
					) : (
						<p className="placeholder-text">暂无群公告</p>
					)}
				</div>
			</section>

			<section className={cn("group-info-section", "member-list-section")}>
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
						<div
							className={cn(
								"group-info-member-row",
								member.role === "owner" && "is-owner",
								member.role === "admin" && "is-admin"
							)}
							key={member.id}
						>
							<div className="member-avatar-wrap">
								<Avatar
									name={displayUserName(member)}
									avatarUrl={member.avatarUrl}
									seed={member.identityValue}
								/>
							</div>
							<span className="member-name-text">{displayUserName(member)}</span>
							{member.kind === "bot" ? (
								<small
									className={cn("bot-badge")}
									aria-label="机器人"
									title="机器人"
								>
									<Bot size={12} strokeWidth={2.4} />
								</small>
							) : null}
						</div>
					))}
				</div>
			</section>
		</aside>
	);
}
