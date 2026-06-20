// @ts-nocheck
import {
	Activity,
	Beer,
	BookOpen,
	Bookmark,
	Cake,
	CalendarDays,
	Check,
	Copy,
	Dumbbell,
	Fingerprint,
	Flame,
	Flower2,
	FolderClosed,
	Gamepad2,
	Heart,
	HelpCircle,
	Info,
	Megaphone,
	Sparkles,
	User,
	Users,
	Utensils,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "./classNames";
import { copyTextToClipboard } from "./clipboard";
import { formatProfileDate } from "./format";
import { Avatar, EmptyState } from "./primitives";
import type { Contact, Conversation } from "./types";
import { displayUserName } from "./user";

/**
 * 扩展（密友）关系映射。`intimate` 为真的是密友关系（情侣/死党/闺蜜/基友），
 * 在资料卡里用主题渐变填充的关系 pill 重点渲染；其余是「搭子」关系，用柔和描边 pill。
 * 未知 id 一律按游戏搭子处理。图标全部取自 lucide 图标库。
 */
const RELATION_META: Record<
	number,
	{ label: string; Icon: typeof Heart; intimate: boolean }
> = {
	1: { label: "情侣", Icon: Heart, intimate: true },
	26: { label: "死党", Icon: Flame, intimate: true },
	2: { label: "闺蜜", Icon: Flower2, intimate: true },
	3: { label: "基友", Icon: Beer, intimate: true },
	82: { label: "运动搭子", Icon: Dumbbell, intimate: false },
	81: { label: "学习搭子", Icon: BookOpen, intimate: false },
	101: { label: "饭搭子", Icon: Utensils, intimate: false },
};

const DEFAULT_RELATION = { label: "游戏搭子", Icon: Gamepad2, intimate: false };

function relationMeta(id: number) {
	return RELATION_META[id] ?? DEFAULT_RELATION;
}

/** 由出生月日推算星座名（标准日期分界）。缺月或日时返回 null。 */
function constellationOf(month?: number, day?: number) {
	if (!month || !day) {
		return null;
	}
	const table: Array<[cutoff: number, name: string]> = [
		[20, "水瓶座"],
		[19, "双鱼座"],
		[21, "白羊座"],
		[20, "金牛座"],
		[21, "双子座"],
		[22, "巨蟹座"],
		[23, "狮子座"],
		[23, "处女座"],
		[23, "天秤座"],
		[24, "天蝎座"],
		[23, "射手座"],
		[22, "摩羯座"],
	];
	const idx = month - 1;
	const entry = day < table[idx][0] ? table[(idx + 11) % 12] : table[idx];
	return entry[1];
}

function birthdayText(year?: number, month?: number, day?: number) {
	if (!month || !day) {
		return null;
	}
	return year && year > 0
		? `${year} 年 ${month} 月 ${day} 日`
		: `${month} 月 ${day} 日`;
}

/** createdAt 对好友是 epoch（无真实入会时间），>2000 才认为有效。 */
function realCreatedAt(value?: string) {
	if (!value) {
		return null;
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime()) || date.getFullYear() <= 2000) {
		return null;
	}
	return formatProfileDate(value);
}

/**
 * 联系人主区域占位。好友资料改为点击弹出灯箱（{@link ContactProfileDialog}），
 * 右半边主区域留白，作为后续功能预留位。
 */
export function ContactProfilePane() {
	return (
		<section className={cn("contact-profile-empty weq-contact-reserved")}>
			<EmptyState title="联系人" body="在左侧选择联系人，查看资料卡片。" />
		</section>
	);
}

/**
 * 群聊主区域占位。群资料同样改为点击弹出灯箱（{@link GroupProfileDialog}）。
 */
export function GroupProfilePane() {
	return (
		<section className={cn("contact-profile-empty weq-contact-reserved")}>
			<EmptyState title="群聊" body="在左侧选择群聊，查看群资料。" />
		</section>
	);
}

/**
 * 好友资料灯箱。点击联系人弹出，居中小卡，沿用 weq 设计（#0099ff 主题、细描边、
 * 小圆角）。密友关系用主题渐变 pill 重点渲染，搭子关系用柔和描边 pill。
 */
export function ContactProfileDialog({
	contact,
	onClose,
}: {
	contact: Contact | undefined;
	onClose: () => void;
}) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		setCopied(false);
	}, [contact?.id]);

	useEffect(() => {
		if (!contact) {
			return undefined;
		}
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") {
				onClose();
			}
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [contact, onClose]);

	if (!contact) {
		return null;
	}
	const profile = contact;

	const ext = profile.extRelation;
	const displayId =
		ext && ext.displayId && ext.displayId > 0
			? ext.displayId
			: (ext?.preselectedIds?.[0] ?? null);
	const headline = displayId != null ? relationMeta(displayId) : null;
	const tags = ext
		? (ext.preselectedIds ?? [])
				.filter((id) => id !== displayId)
				.map((id) => ({ id, ...relationMeta(id) }))
		: [];

	const zodiac = constellationOf(profile.birthMonth, profile.birthDay);
	const gender = genderLabel(profile.gender);
	const genderAge = [gender, profile.age ? `${profile.age} 岁` : null]
		.filter(Boolean)
		.join(" · ");
	const statusText = profile.customStatus || profile.onlineStatus;
	const birthday = birthdayText(
		profile.birthYear,
		profile.birthMonth,
		profile.birthDay,
	);
	const createdAt = realCreatedAt(profile.createdAt);
	const intimacy = profile.intimacy
		? Number(profile.intimacy).toLocaleString("en-US")
		: null;
	const nickDiffers =
		profile.nick &&
		profile.nick !== displayUserName(profile) &&
		profile.nick !== profile.remark;

	async function copyIdentity() {
		const ok = await copyTextToClipboard(profile.identityValue);
		if (ok) {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		}
	}

	return (
		<div className="weq-profile-layer" role="presentation" onMouseDown={onClose}>
			<section
				className="weq-profile-dialog weq-anim-pop"
				role="dialog"
				aria-modal="true"
				aria-label="好友资料"
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

				<div className="weq-profile-hero">
					<span className="weq-profile-avatar">
						<Avatar
							name={displayUserName(profile)}
							avatarUrl={profile.avatarUrl}
							seed={profile.identityValue}
						/>
					</span>
					<strong className="weq-profile-name">
						{displayUserName(profile)}
					</strong>
					{nickDiffers ? (
						<span className="weq-profile-nick">昵称 {profile.nick}</span>
					) : null}
					<button
						className="weq-profile-id"
						type="button"
						onClick={copyIdentity}
						title="点击复制"
					>
						<span>{profile.identityLabel}</span>
						<span className="weq-number">{profile.identityValue}</span>
						{copied ? <Check size={12} /> : <Copy size={12} />}
					</button>

					{headline || genderAge || zodiac ? (
						<div className="weq-profile-chips">
							{headline ? (
								<span
									className={cn(
										"weq-profile-rel",
										headline.intimate && "is-intimate",
									)}
								>
									<headline.Icon size={13} strokeWidth={2.2} />
									{headline.intimate ? `密友 · ${headline.label}` : headline.label}
								</span>
							) : null}
							{genderAge ? (
								<span className="weq-profile-chip">{genderAge}</span>
							) : null}
							{zodiac ? (
								<span className="weq-profile-chip">
									<Sparkles size={12} />
									{zodiac}
								</span>
							) : null}
						</div>
					) : null}

					{tags.length ? (
						<div className="weq-profile-tags">
							{tags.map((tag) => (
								<span key={tag.id} className="weq-profile-tag">
									<tag.Icon size={12} />
									{tag.label}
								</span>
							))}
						</div>
					) : null}

					{profile.signature ? (
						<p className="weq-profile-sign">{profile.signature}</p>
					) : null}
				</div>

				<div className="weq-profile-list">
					<ProfileRow
						icon={<User size={13} />}
						label="用户名"
						value={profile.username}
						mono
					/>
					{profile.qid ? (
						<ProfileRow
							icon={<Fingerprint size={13} />}
							label="QID"
							value={profile.qid}
							mono
						/>
					) : null}
					{profile.categoryName ? (
						<ProfileRow
							icon={<FolderClosed size={13} />}
							label="分组"
							value={profile.categoryName}
						/>
					) : null}
					{statusText ? (
						<ProfileRow
							icon={<Activity size={13} />}
							label="状态"
							value={statusText}
						/>
					) : null}
					{birthday ? (
						<ProfileRow
							icon={<Cake size={13} />}
							label="生日"
							value={birthday}
						/>
					) : null}
					{intimacy ? (
						<ProfileRow
							icon={<Heart size={13} />}
							label="亲密度"
							value={intimacy}
							mono
							accent
						/>
					) : null}
					{createdAt ? (
						<ProfileRow
							icon={<CalendarDays size={13} />}
							label="成为好友"
							value={createdAt}
						/>
					) : null}
				</div>
			</section>
		</div>
	);
}

/**
 * 群资料灯箱。结构与好友灯箱一致；「群成员 N 人」下方横向展示若干成员头像
 * （成员由上层从 group_member3 拉取后挂在 conversation.members 上）。
 */
export function GroupProfileDialog({
	conversation,
	onClose,
}: {
	conversation: Extract<Conversation, { type: "group" }> | undefined;
	onClose: () => void;
}) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		setCopied(false);
	}, [conversation?.id]);

	useEffect(() => {
		if (!conversation) {
			return undefined;
		}
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") {
				onClose();
			}
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [conversation, onClose]);

	if (!conversation) {
		return null;
	}
	const group = conversation.group;
	const members = (conversation.members ?? []).slice(0, 14);

	async function copyCode() {
		const ok = await copyTextToClipboard(group.identityValue);
		if (ok) {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		}
	}

	return (
		<div className="weq-profile-layer" role="presentation" onMouseDown={onClose}>
			<section
				className="weq-profile-dialog weq-anim-pop"
				role="dialog"
				aria-modal="true"
				aria-label="群资料"
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

				<div className="weq-profile-hero">
					<span className="weq-profile-avatar">
						<Avatar
							name={group.name}
							avatarUrl={group.avatarUrl}
							seed={group.identityValue}
						/>
					</span>
					<strong className="weq-profile-name">{group.name}</strong>
					<button
						className="weq-profile-id"
						type="button"
						onClick={copyCode}
						title="点击复制"
					>
						<span>群号</span>
						<span className="weq-number">{group.identityValue}</span>
						{copied ? <Check size={12} /> : <Copy size={12} />}
					</button>
				</div>

				<div className="weq-profile-members">
					<div className="weq-profile-members-head">
						<Users size={13} />
						<span>群成员</span>
						<strong className="weq-number">{group.memberCount}</strong>
						<span>人</span>
					</div>
					{members.length ? (
						<div className="weq-profile-members-row">
							{members.map((member) => (
								<span
									key={member.id}
									className="weq-profile-member"
									title={displayUserName(member)}
								>
									<Avatar
										name={displayUserName(member)}
										avatarUrl={member.avatarUrl}
										seed={member.identityValue}
									/>
								</span>
							))}
						</div>
					) : null}
				</div>

				<div className="weq-profile-list">
					<ProfileRow
						icon={<Megaphone size={13} />}
						label="群公告"
						value={group.announcement?.trim() || "未设置"}
						multiline
					/>
					{group.description ? (
						<ProfileRow
							icon={<Info size={13} />}
							label="群简介"
							value={group.description}
							multiline
						/>
					) : null}
					{group.remark ? (
						<ProfileRow
							icon={<Bookmark size={13} />}
							label="群备注"
							value={group.remark}
							multiline
						/>
					) : null}
					{group.createTime ? (
						<ProfileRow
							icon={<CalendarDays size={13} />}
							label="创建时间"
							value={formatProfileDate(group.createTime)}
						/>
					) : null}
					{group.maxMemberCount ? (
						<ProfileRow
							icon={<Users size={13} />}
							label="群容量"
							value={`${group.memberCount}/${group.maxMemberCount}`}
							mono
						/>
					) : null}
					{group.entranceQ ? (
						<ProfileRow
							icon={<HelpCircle size={13} />}
							label="入群问题"
							value={group.entranceQ}
							multiline
						/>
					) : null}
				</div>
			</section>
		</div>
	);
}

function ProfileRow({
	icon,
	label,
	value,
	mono,
	accent,
	multiline,
}: {
	icon?: React.ReactNode;
	label: string;
	value: string;
	mono?: boolean;
	accent?: boolean;
	multiline?: boolean;
}) {
	if (multiline) {
		return (
			<div className="weq-profile-row weq-profile-row--block">
				<span className="weq-profile-row-label">
					{icon}
					{label}
				</span>
				<p className="weq-profile-row-text">{value}</p>
			</div>
		);
	}
	return (
		<div className="weq-profile-row">
			<span className="weq-profile-row-label">
				{icon}
				{label}
			</span>
			<strong className={cn(mono && "weq-number", accent && "is-accent")}>
				{value}
			</strong>
		</div>
	);
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
