// @ts-nocheck
import { Bell, Users, X } from "lucide-react";
import { useEffect } from "react";
import { cn } from "./classNames";
import { formatProfileDate } from "./format";
import { Avatar, EmptyState } from "./primitives";
import type { ContactRequest, GroupJoinRequest } from "./types";
import { displayUserName } from "./user";

/** Esc 关闭灯箱；仅在打开时挂监听。 */
function useEscClose(active: boolean, onClose: () => void) {
	useEffect(() => {
		if (!active) {
			return undefined;
		}
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") {
				onClose();
			}
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [active, onClose]);
}

/**
 * 好友通知灯箱。沿用 weq 设计：遮罩 + 居中卡片，固定标题 + 可滚动列表。
 * 内容为只读展示（与原 ContactNoticePane 一致），改为弹窗滚动查看。
 */
export function ContactNoticeDialog({
	open,
	requests,
	onClose,
}: {
	open: boolean;
	requests: ContactRequest[];
	onClose: () => void;
}) {
	useEscClose(open, onClose);
	if (!open) {
		return null;
	}

	return (
		<div className="weq-profile-layer" role="presentation" onMouseDown={onClose}>
			<section
				className="weq-notice-dialog weq-anim-pop"
				role="dialog"
				aria-modal="true"
				aria-label="好友通知"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<button
					className="weq-profile-close"
					type="button"
					title="关闭"
					aria-label="关闭"
					onClick={onClose}
				>
					<X size={16} />
				</button>
				<header className="weq-notice-head">
					<Bell size={15} />
					<h2>好友通知</h2>
				</header>
				<div
					className={cn("weq-notice-scroll", requests.length === 0 && "is-empty")}
				>
					{requests.length === 0 ? (
						<EmptyState
							title="暂无好友通知"
							body="收到或发出的好友申请会显示在这里。"
							icon={<Bell />}
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
		</div>
	);
}

/** 61003 处理状态 → 徽标文案 + 配色修饰类。配色全部走主题色，只用填充/描边区分。 */
const HANDLE_STATE_LABEL: Record<
	GroupJoinRequest["handleState"],
	{ text: string; tone: string } | null
> = {
	none: null,
	pending: { text: "待处理", tone: "is-pending" },
	agreed: { text: "已同意", tone: "is-agreed" },
	refused: { text: "已拒绝", tone: "is-refused" },
};

/**
 * 附言拆成「标签 / 内容」对。入群问答原文是 `问题：…\n答案：…`，整条塞进一行里
 * 全是文字，看不出层次；拆开后标签走弱化色、内容走正文色。
 * 拆不出来（普通留言）就整条当内容。
 */
const ANSWER_LINE = /^([^：:\n]{1,8})[：:]\s*(.*)$/;

function splitNoticeMessage(message: string): Array<{ label?: string; value: string }> {
	return message
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const m = ANSWER_LINE.exec(line);
			return m?.[2] ? { label: m[1], value: m[2] } : { value: line };
		});
}

/**
 * 群通知灯箱。结构与好友通知一致；保留存疑申请标记（notice-doubt-mark）。
 * 卡片三段：头像 / 正文（申请人+群名+动作、附言问答对）/ 右上角状态徽标 + 时间。
 * 每行 nowrap + 省略号，长群名靠 CSS 截断而不是把时间挤到下一行。
 */
export function GroupNoticeDialog({
	open,
	requests,
	onClose,
}: {
	open: boolean;
	requests: GroupJoinRequest[];
	onClose: () => void;
}) {
	useEscClose(open, onClose);
	if (!open) {
		return null;
	}

	return (
		<div className="weq-profile-layer" role="presentation" onMouseDown={onClose}>
			<section
				className="weq-notice-dialog weq-anim-pop"
				role="dialog"
				aria-modal="true"
				aria-label="群通知"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<button
					className="weq-profile-close"
					type="button"
					title="关闭"
					aria-label="关闭"
					onClick={onClose}
				>
					<X size={16} />
				</button>
				<header className="weq-notice-head">
					<Users size={15} />
					<h2>群通知</h2>
				</header>
				<div
					className={cn("weq-notice-scroll", requests.length === 0 && "is-empty")}
				>
					{requests.length === 0 ? (
						<EmptyState
							title="暂无群通知"
							body="入群申请和处理结果会显示在这里。"
							icon={<Users />}
						/>
					) : (
						requests.map((request) => {
							const badge = HANDLE_STATE_LABEL[request.handleState];
							const who = displayUserName(request.user);
							const fields = request.message ? splitNoticeMessage(request.message) : [];
							return (
								<article
									className={cn("notice-card", "notice-card-group", badge?.tone)}
									key={request.id}
								>
									<Avatar
										name={who}
										avatarUrl={request.user.avatarUrl}
										seed={request.user.identityValue}
									/>
									<div className={cn("notice-copy")}>
										<p className="notice-line-head">
											<span className="notice-who" title={who}>
												{who}
											</span>
											<span className="notice-action-text">{request.action}</span>
										</p>
										<p className="notice-line-group">
											<span className="notice-group-name" title={request.group.name}>
												{request.group.name}
											</span>
										</p>
										{fields.length > 0 ? (
											<dl className="notice-fields">
												{fields.map((field) => (
													<div className="notice-field" key={`${field.label ?? ""}${field.value}`}>
														{field.label ? <dt>{field.label}</dt> : null}
														<dd title={field.value}>{field.value}</dd>
													</div>
												))}
											</dl>
										) : null}
										{request.operator ? (
											<span className="notice-operator">
												由 {displayUserName(request.operator)} 处理
												{request.respondedAt
													? ` · ${formatProfileDate(request.respondedAt)}`
													: ""}
											</span>
										) : null}
										{request.systemRemark ? (
											<span className="notice-sysremark">{request.systemRemark}</span>
										) : null}
									</div>
									<div className="notice-meta">
										{badge ? (
											<em className={cn("notice-state", badge.tone)}>{badge.text}</em>
										) : null}
										<time>{formatProfileDate(request.createdAt)}</time>
									</div>
									{request.isDoubt ? (
										<div className={cn("notice-doubt-mark")} />
									) : null}
								</article>
							);
						})
					)}
				</div>
			</section>
		</div>
	);
}
