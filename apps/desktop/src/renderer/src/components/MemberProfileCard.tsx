// @ts-nocheck
/**
 * 群成员资料卡片（贴光标弹出的 anchored popover）。
 *
 * 点击群成员列表某一行时，在鼠标点击处弹出。基础信息（头像 / 群名片 / 角色 /
 * 头衔 / 等级 / 入群时间）直接取自已在手的 GroupMember，QQ 号 / 昵称 / 性别 /
 * 年龄 / 生日 / 签名 / 亲密度等「陌生人资料」字段异步走 account.getProfile(uid)
 * 从 profile_info_v6 补全。视觉沿用好友资料灯箱（weq-profile-*）的设计语言，
 * 只是把居中灯箱换成贴光标的浮层。
 */
import {
	Award,
	BadgeCheck,
	Cake,
	CalendarDays,
	Check,
	Clock,
	Copy,
	Crown,
	Fingerprint,
	Hash,
	Heart,
	Loader2,
	Shield,
	Sparkles,
	User as UserIcon,
	X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { client } from "../trpc/client";
import { Avatar } from "../im-template/template/primitives";
import { cn } from "../im-template/template/classNames";
import { copyTextToClipboard } from "../im-template/template/clipboard";
import { displayUserName } from "../im-template/template/user";
import { useEscapeToClose } from "../im-template/template/modalUtils";
import {
	ProfileRow,
	birthdayText,
	constellationOf,
	genderLabel,
} from "../im-template/template/profilePanes";

/** ISO 字符串 → zh-CN 年月日；无效 / 空 / epoch 返回 null。 */
function shortDate(value) {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime()) || date.getFullYear() <= 2000) return null;
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

const ROLE_META = {
	owner: { label: "群主", Icon: Crown, cls: "is-owner" },
	admin: { label: "管理员", Icon: Shield, cls: "is-admin" },
};

export function MemberProfileCard({ member, anchor, onClose }) {
	const [profile, setProfile] = useState(null);
	const [loading, setLoading] = useState(true);
	const [copied, setCopied] = useState(false);
	const cardRef = useRef(null);
	const [pos, setPos] = useState({ left: anchor.x + 14, top: anchor.y + 8, ready: false });

	// 真正的 uid 在 member.id；member.identityValue 展示用的是 uin（QQ号）。
	// getProfile 需要 uid，早先误传 identityValue(=uin) 会拉不到 profile_info_v6。
	const uid = member.id;

	useEscapeToClose(onClose);

	// 补全陌生人资料字段。
	useEffect(() => {
		let alive = true;
		setLoading(true);
		setProfile(null);
		client.account.getProfile
			.query({ uid })
			.then((p) => {
				if (alive) {
					setProfile(p);
					setLoading(false);
				}
			})
			.catch(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [uid]);

	// 测量真实尺寸后把卡片夹在视口内：默认落在光标右下，右 / 下溢出则翻向左 / 上。
	useLayoutEffect(() => {
		const el = cardRef.current;
		if (!el) return;
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const M = 10;
		let left = anchor.x + 14;
		let top = anchor.y + 8;
		if (left + w > vw - M) left = anchor.x - w - 14;
		if (left < M) left = M;
		if (top + h > vh - M) top = vh - h - M;
		if (top < M) top = M;
		setPos({ left, top, ready: true });
	}, [anchor.x, anchor.y, loading, profile]);

	const name = displayUserName(member);
	const role = ROLE_META[member.role];
	const uin = profile?.uin && profile.uin !== "0" ? profile.uin : null;
	const nickDiffers = profile?.nick && profile.nick !== name && profile.nick !== member.remark;
	const gender = genderLabel(profile?.gender);
	const genderAge = [gender, profile?.age ? `${profile.age} 岁` : null].filter(Boolean).join(" · ");
	const zodiac = profile ? constellationOf(profile.birthMonth, profile.birthDay) : null;
	const birthday = profile ? birthdayText(profile.birthYear, profile.birthMonth, profile.birthDay) : null;
	const intimacy =
		profile?.intimacy && Number(profile.intimacy) > 0
			? Number(profile.intimacy).toLocaleString("en-US")
			: null;
	// 群等级 = 数字等级（memberLevel）；levelName 是群主给各等级段起的段位名称
	// （元老 / 潜水 …），是「头衔样式」的字符串，只作为副标题附在数字后面，
	// 不能单独当等级展示——否则看起来就成了群头衔。
	const levelText = member.memberLevel
		? `Lv.${member.memberLevel}${
				member.levelName && member.levelName !== `Lv${member.memberLevel}`
					? ` · ${member.levelName}`
					: ""
			}`
		: member.levelName || null;
	const joinedAt = shortDate(member.joinedAt);
	const lastSpeak = shortDate(member.lastSpeakAt);

	async function copyUin() {
		if (!uin) return;
		const ok = await copyTextToClipboard(uin);
		if (ok) {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		}
	}

	return createPortal(
		<div
			className="weq-member-pop-scrim"
			role="presentation"
			style={{ position: "fixed", inset: 0, zIndex: 90 }}
			onMouseDown={onClose}
		>
			<section
				ref={cardRef}
				className="weq-member-pop weq-anim-pop"
				style={{
					position: "fixed",
					left: pos.left,
					top: pos.top,
					opacity: pos.ready ? 1 : 0,
				}}
				role="dialog"
				aria-modal="true"
				aria-label="群成员资料"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<button
					className="weq-profile-close"
					type="button"
					title="关闭"
					aria-label="关闭"
					onClick={onClose}
				>
					<X size={15} />
				</button>

				<div className="weq-profile-hero">
					<span className="weq-profile-avatar">
						<Avatar name={name} avatarUrl={member.avatarUrl} seed={uid} />
					</span>
					<strong className="weq-profile-name">{name}</strong>
					{nickDiffers ? <span className="weq-profile-nick">昵称 {profile.nick}</span> : null}

					{uin ? (
						<button className="weq-profile-id" type="button" onClick={copyUin} title="点击复制">
							<span>QQ</span>
							<span className="weq-number">{uin}</span>
							{copied ? <Check size={12} /> : <Copy size={12} />}
						</button>
					) : null}

					{role || genderAge || zodiac ? (
						<div className="weq-profile-chips">
							{role ? (
								<span className={cn("weq-profile-rel", role.cls)}>
									<role.Icon size={13} strokeWidth={2.2} />
									{role.label}
								</span>
							) : null}
							{genderAge ? <span className="weq-profile-chip">{genderAge}</span> : null}
							{zodiac ? (
								<span className="weq-profile-chip">
									<Sparkles size={12} />
									{zodiac}
								</span>
							) : null}
						</div>
					) : null}

					{member.customTitle ? (
						<div className="weq-profile-chips">
							<span className="weq-member-title">
								<BadgeCheck size={12} />
								{member.customTitle}
							</span>
						</div>
					) : null}

					{profile?.signature ? <p className="weq-profile-sign">{profile.signature}</p> : null}
				</div>

				<div className="weq-profile-list">
					{levelText ? (
						<ProfileRow icon={<Award size={13} />} label="群等级" value={levelText} />
					) : null}
					{birthday ? <ProfileRow icon={<Cake size={13} />} label="生日" value={birthday} /> : null}
					{intimacy ? (
						<ProfileRow icon={<Heart size={13} />} label="亲密度" value={intimacy} mono accent />
					) : null}
					{joinedAt ? (
						<ProfileRow icon={<CalendarDays size={13} />} label="入群时间" value={joinedAt} />
					) : null}
					{lastSpeak ? (
						<ProfileRow icon={<Clock size={13} />} label="最后发言" value={lastSpeak} />
					) : null}
					{profile?.remark ? (
						<ProfileRow icon={<UserIcon size={13} />} label="备注" value={profile.remark} />
					) : null}
					{profile?.qid ? (
						<ProfileRow icon={<Fingerprint size={13} />} label="QID" value={profile.qid} mono />
					) : null}
					<ProfileRow icon={<Hash size={13} />} label="UID" value={uid} mono />
				</div>

				{loading ? (
					<div className="weq-member-loading">
						<Loader2 size={14} />
						<span>加载资料…</span>
					</div>
				) : null}
			</section>
		</div>,
		document.body,
	);
}
