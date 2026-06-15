// @ts-nocheck
import { ChevronDown, ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "./classNames";
import { formatProfileDate } from "./format";
import { Avatar, EmptyState } from "./primitives";
import type { ContactRequest, GroupJoinRequest } from "./types";
import { displayUserName } from "./user";

export function ContactNoticePane({
	requests,
	onAccept,
	onReject,
	onBack,
}: {
	requests: ContactRequest[];
	onAccept: (requestId: string) => Promise<void>;
	onReject: (requestId: string) => Promise<void>;
	onBack?: () => void;
}) {
	const [rejectMenuId, setRejectMenuId] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	useEffect(() => {
		if (!rejectMenuId) {
			return;
		}

		function closeOnOutside(event: MouseEvent) {
			if (!(event.target as Element).closest(".notice-action-wrap")) {
				setRejectMenuId(null);
			}
		}

		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setRejectMenuId(null);
			}
		}

		document.addEventListener("mousedown", closeOnOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("mousedown", closeOnOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [rejectMenuId]);

	async function accept(requestId: string) {
		setBusyId(requestId);
		setRejectMenuId(null);
		try {
			await onAccept(requestId);
		} finally {
			setBusyId(null);
		}
	}

	async function reject(requestId: string) {
		setBusyId(requestId);
		setRejectMenuId(null);
		try {
			await onReject(requestId);
		} finally {
			setBusyId(null);
		}
	}

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
							<div className={cn("notice-action")}>
								{request.direction === "incoming" &&
								request.status === "pending" ? (
									<div className={cn("notice-action-wrap")}>
										<div className={cn("notice-split-button")}>
											<button
												type="button"
												disabled={busyId === request.id}
												onClick={() => void accept(request.id)}
											>
												同意
											</button>
											<button
												type="button"
												disabled={busyId === request.id}
												onClick={() =>
													setRejectMenuId((current) =>
														current === request.id ? null : request.id,
													)
												}
											>
												<ChevronDown size={18} />
											</button>
										</div>
										{rejectMenuId === request.id ? (
											<div className={cn("notice-mini-menu")}>
												<button
													type="button"
													onClick={() => void reject(request.id)}
												>
													拒绝
												</button>
											</div>
										) : null}
									</div>
								) : (
									<span>{contactRequestStatusLabel(request)}</span>
								)}
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
	onAccept,
	onReject,
	onBack,
}: {
	requests: GroupJoinRequest[];
	onAccept: (requestId: string) => Promise<void>;
	onReject: (requestId: string) => Promise<void>;
	onBack?: () => void;
}) {
	const [rejectMenuId, setRejectMenuId] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	useEffect(() => {
		if (!rejectMenuId) {
			return;
		}

		function closeOnOutside(event: MouseEvent) {
			if (!(event.target as Element).closest(".notice-action-wrap")) {
				setRejectMenuId(null);
			}
		}

		function closeOnEscape(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setRejectMenuId(null);
			}
		}

		document.addEventListener("mousedown", closeOnOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("mousedown", closeOnOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [rejectMenuId]);

	async function accept(requestId: string) {
		setBusyId(requestId);
		setRejectMenuId(null);
		try {
			await onAccept(requestId);
		} finally {
			setBusyId(null);
		}
	}

	async function reject(requestId: string) {
		setBusyId(requestId);
		setRejectMenuId(null);
		try {
			await onReject(requestId);
		} finally {
			setBusyId(null);
		}
	}

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
							<div className={cn("notice-action")}>
								{request.direction === "incoming" &&
								request.status === "pending" ? (
									<div className={cn("notice-action-wrap")}>
										<div className={cn("notice-split-button")}>
											<button
												type="button"
												disabled={busyId === request.id}
												onClick={() => void accept(request.id)}
											>
												同意
											</button>
											<button
												type="button"
												disabled={busyId === request.id}
												onClick={() =>
													setRejectMenuId((current) =>
														current === request.id ? null : request.id,
													)
												}
											>
												<ChevronDown size={18} />
											</button>
										</div>
										{rejectMenuId === request.id ? (
											<div className={cn("notice-mini-menu")}>
												<button
													type="button"
													onClick={() => void reject(request.id)}
												>
													拒绝
												</button>
											</div>
										) : null}
									</div>
								) : (
									<span>{groupRequestStatusLabel(request)}</span>
								)}
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

function contactRequestStatusLabel(request: ContactRequest) {
	if (request.status === "accepted") {
		return "已同意";
	}
	if (request.status === "rejected") {
		return "已拒绝";
	}
	if (request.status === "cancelled") {
		return "已取消";
	}
	return request.direction === "outgoing" ? "等待验证" : "待处理";
}

function groupRequestStatusLabel(request: GroupJoinRequest) {
	if (request.status === "accepted") {
		return "已同意";
	}
	if (request.status === "rejected") {
		return "已拒绝";
	}
	if (request.status === "cancelled") {
		return "已取消";
	}
	return request.direction === "outgoing" ? "等待验证" : "待处理";
}
