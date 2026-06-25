// @ts-nocheck
import { Bot, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { Avatar } from "./primitives";
import type { GroupConversationView } from "./conversationDetailsTypes";
import { displayUserName } from "./user";
import { cn } from "./classNames";

export type GroupInfoDetail = "profile" | "announcements" | "essence" | "albums";

export function GroupInfoPanel({
	conversation,
	onLoadMoreMembers,
	loadingMoreMembers,
	onOpenDetail,
}: {
	conversation: GroupConversationView;
	onLoadMoreMembers?: () => void;
	loadingMoreMembers?: boolean;
	onOpenDetail?: (detail: GroupInfoDetail) => void;
}) {
	const memberListRef = useRef<HTMLDivElement | null>(null);
	const group = conversation.group;
	const metaRows = [
		group.description ? ["群简介", group.description] : null,
		group.remark ? ["群备注", group.remark] : null,
		group.createTime ? ["创建时间", formatShortDate(group.createTime)] : null,
		group.maxMemberCount ? ["群容量", `${group.memberCount}/${group.maxMemberCount}`] : null,
		group.labels ? ["标签", group.labels] : null,
		group.customLabels?.length ? ["自定义标签", group.customLabels.join("、")] : null,
		group.addressName ? ["群地点", group.addressName] : null,
		group.entranceQ ? ["入群问题", group.entranceQ] : null,
	].filter(Boolean) as string[][];

	const requestMoreMembersNearBottom = useCallback(() => {
		const list = memberListRef.current;
		if (!list || !onLoadMoreMembers) return;
		const distanceToBottom =
			list.scrollHeight - list.clientHeight - list.scrollTop;
		if (distanceToBottom <= 96) {
			onLoadMoreMembers();
		}
	}, [onLoadMoreMembers]);

	useEffect(() => {
		const list = memberListRef.current;
		if (!list) return undefined;
		const frame = window.requestAnimationFrame(requestMoreMembersNearBottom);
		return () => window.cancelAnimationFrame(frame);
	}, [conversation.members.length, requestMoreMembersNearBottom]);

	return (
		<aside className={cn("group-info-panel")} aria-label="群聊资料">
			<section className={cn("group-info-section", "group-info-overview")}>
				<header className={cn("group-info-heading")}>
					<button
						className={cn("group-info-title-button")}
						type="button"
						title="查看群资料"
						onClick={() => onOpenDetail?.("profile")}
					>
						<strong>群资料</strong>
					</button>
				</header>
				<div className={cn("group-info-meta-list")}>
					{metaRows.length > 0 ? (
						metaRows.map(([label, value]) => (
							<button
								className={cn("group-info-meta-row")}
								type="button"
								key={label}
								onClick={() => onOpenDetail?.("profile")}
							>
								<span>{label}</span>
								<strong>{value}</strong>
							</button>
						))
					) : (
						<p className={cn("placeholder-text")}>暂无更多资料</p>
					)}
				</div>
			</section>

			<section className={cn("group-info-section", "member-list-section")}>
				<header className={cn("group-info-heading group-info-title-row")}>
					<strong>群聊成员 {conversation.group.memberCount}</strong>
				</header>
				<div
					className={cn("group-info-member-list")}
					ref={memberListRef}
					onScroll={requestMoreMembersNearBottom}
				>
					{conversation.members.map((member) => (
						<div
							className={cn(
								"group-info-member-row",
								member.role === "owner" && "is-owner",
								member.role === "admin" && "is-admin",
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
							<span className="member-name-text">
								<span className="member-name-with-badge">
									<span className="member-display-name">{displayUserName(member)}</span>
									{member.role === "owner" ? (
										<small className="member-badge owner">群主</small>
									) : member.role === "admin" ? (
										<small className="member-badge admin">管理员</small>
									) : null}
								</span>
							</span>
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
					{loadingMoreMembers ? (
						<div className={cn("group-info-member-loading")}>加载中</div>
					) : null}
				</div>
			</section>
		</aside>
	);
}

export function GroupInfoDetailDialog({
	conversation,
	detail,
	onClose,
	onJumpToMessage,
}: {
	conversation: GroupConversationView;
	detail: GroupInfoDetail;
	onClose: () => void;
	onJumpToMessage?: (seq: number) => void;
}) {
	const group = conversation.group;
	const rawAnnouncement = group.announcement?.trim();
	const bulletins = group.bulletins ?? [];
	const essenceMessages = group.essenceMessages ?? [];
	const profileRows = [
		["群名称", group.name],
		[group.identityLabel, group.identityValue],
		group.description ? ["群简介", group.description] : null,
		group.remark ? ["群备注", group.remark] : null,
		group.createTime ? ["创建时间", formatShortDate(group.createTime)] : null,
		group.maxMemberCount ? ["群容量", `${group.memberCount}/${group.maxMemberCount}`] : null,
		group.labels ? ["标签", group.labels] : null,
		group.customLabels?.length ? ["自定义标签", group.customLabels.join("、")] : null,
		group.addressName ? ["群地点", group.addressName] : null,
		group.entranceQ ? ["入群问题", group.entranceQ] : null,
	].filter(Boolean) as string[][];

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
			className={cn("modal-scrim", "group-info-detail-scrim")}
			role="presentation"
			onMouseDown={onClose}
		>
			<section
				className={cn("group-info-detail-dialog")}
				role="dialog"
				aria-modal="true"
				aria-label={groupInfoDetailTitle(detail)}
				onMouseDown={(event) => event.stopPropagation()}
			>
				<header>
					<div>
						<strong>{groupInfoDetailTitle(detail)}</strong>
						<span>{group.name}</span>
					</div>
					<button
						className={cn("icon-button")}
						type="button"
						title="关闭"
						onClick={onClose}
					>
						<X size={18} />
					</button>
				</header>

				<div className={cn("group-info-detail-body")}>
					{detail === "profile" ? (
						<div className={cn("group-info-detail-rows")}>
							{profileRows.map(([label, value]) => (
								<div className={cn("group-info-detail-row")} key={label}>
									<span>{label}</span>
									<strong>{value}</strong>
								</div>
							))}
						</div>
					) : null}

					{detail === "announcements" ? (
						<div className={cn("group-info-detail-records")}>
							{rawAnnouncement ? (
								<article className={cn("group-info-detail-record")}>
									<span>当前公告</span>
									<p>{rawAnnouncement}</p>
								</article>
							) : null}
							{bulletins.map((bulletin) => (
								<article
									className={cn("group-info-detail-record")}
									key={bulletin.id}
								>
									<span>历史公告 · {formatShortDate(bulletin.createdAt)}</span>
									<p>{bulletin.text}</p>
								</article>
							))}
							{!rawAnnouncement && bulletins.length === 0 ? (
								<p className={cn("placeholder-text")}>暂无群公告</p>
							) : null}
						</div>
					) : null}

					{detail === "essence" ? (
						<div className={cn("group-info-detail-records")}>
							{essenceMessages.map((item) => (
								<article
									className={cn("group-info-detail-record")}
									key={item.id}
									onClick={() => onJumpToMessage?.(item.msgSeq)}
									style={{ cursor: onJumpToMessage ? "pointer" : undefined }}
								>
									<span>
										{formatShortDate(item.createdAt)}
										{item.operatorName ? ` · ${item.operatorName}` : ""}
									</span>
									<p>
										{item.active ? "已设为精华" : "已取消精华"} ·{" "}
										{item.senderName || "Member"}
									</p>
								</article>
							))}
							{essenceMessages.length === 0 ? (
								<p className={cn("placeholder-text")}>暂无群精华</p>
							) : null}
						</div>
					) : null}
				</div>
			</section>
		</div>
	);
}

function groupInfoDetailTitle(detail: GroupInfoDetail) {
	if (detail === "announcements") return "群公告";
	if (detail === "essence") return "群精华";
	return "群资料";
}

function formatShortDate(value: string | null | undefined) {
	if (!value) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return "";
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}
