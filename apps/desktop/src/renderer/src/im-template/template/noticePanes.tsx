// @ts-nocheck
import { ChevronLeft } from "lucide-react";
import { cn } from "./classNames";
import { formatProfileDate } from "./format";
import { Avatar, EmptyState } from "./primitives";
import type { ContactRequest, GroupJoinRequest } from "./types";
import { displayUserName } from "./user";

export function ContactNoticePane({
	requests,
	onBack,
}: {
	requests: ContactRequest[];
	onAccept: (requestId: string) => Promise<void>;
	onReject: (requestId: string) => Promise<void>;
	onBack?: () => void;
}) {
	return (
		<section className={cn("notice-pane")}>
			<NoticeHeader title="好友通知" onBack={onBack} />
			<div className={cn("notice-list")}>
				{requests.length === 0 ? (
					<EmptyState
						title="暂无好友通知"
						body="收到或发出的好友申请会显示在这里。"
					/>
				) : (
					requests.map((request) => (
						<article className={cn("notice-card")} key={request.id}>
							<Avatar
								name={displayUserName(request.user)}
								avatarUrl={request.user.avatarUrl}
								seed={request.user.identityValue}
							/>
							<div className={cn("notice-copy")}>
								<p>
									<span>{displayUserName(request.user)}</span>
									{request.direction === "incoming"
										? " 请求加为好友 "
										: " 正在验证你的邀请 "}
									<time>{formatProfileDate(request.createdAt)}</time>
								</p>
								<strong>留言：{request.message || "请求添加对方为好友"}</strong>
							</div>
						</article>
					))
				)}
			</div>
		</section>
	);
}

export function GroupNoticePane({
	requests,
	onBack,
}: {
	requests: GroupJoinRequest[];
	onAccept: (requestId: string) => Promise<void>;
	onReject: (requestId: string) => Promise<void>;
	onBack?: () => void;
}) {
	return (
		<section className={cn("notice-pane")}>
			<NoticeHeader title="群通知" onBack={onBack} />
			<div className={cn("notice-list")}>
				{requests.length === 0 ? (
					<EmptyState
						title="暂无群通知"
						body="入群申请和处理结果会显示在这里。"
					/>
				) : (
					requests.map((request) => (
						<article className={cn("notice-card")} key={request.id}>
							<Avatar
								name={displayUserName(request.user)}
								avatarUrl={request.user.avatarUrl}
								seed={request.user.identityValue}
							/>
							<div className={cn("notice-copy")}>
								<p>
									<span>{displayUserName(request.user)}</span>
									{request.direction === "incoming"
										? " 申请加入 "
										: " 正在验证加入 "}
									<span>{request.group.name}</span>
									<time>{formatProfileDate(request.createdAt)}</time>
								</p>
								<strong>留言：{request.message || "请求加入群聊"}</strong>
							</div>
						</article>
					))
				)}
			</div>
		</section>
	);
}

function NoticeHeader({
	title,
	onBack,
}: {
	title: string;
	onBack?: () => void;
}) {
	return (
		<header className={cn("notice-header")}>
			{onBack ? (
				<button
					className={cn("icon-button notice-back-button")}
					type="button"
					onClick={onBack}
					title="返回"
				>
					<ChevronLeft size={22} />
				</button>
			) : (
				<span className={cn("notice-back-spacer")} />
			)}
			<h2>{title}</h2>
			<span className={cn("notice-back-spacer")} />
		</header>
	);
}
