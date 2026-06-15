// @ts-nocheck
import { Check, ChevronLeft, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
	avatarInputFromUrl,
	avatarSourceError,
	avatarSourceLabel,
	avatarSourcePlaceholder,
	resolveAvatarUrl,
	type AvatarSource,
} from "./avatar";
import { closeFromScrim, useEscapeToClose } from "./modalUtils";
import { Avatar } from "./primitives";
import type { User } from "./types";
import { cn } from "./classNames";
import { displayUserName } from "./user";

export function ProfileEditorModal({
	user,
	onClose,
	onUserChange,
}: {
	user: User;
	onClose: () => void;
	onUserChange: (user: User) => void;
}) {
	useEscapeToClose(onClose);

	return (
		<div
			className={cn("modal-scrim")}
			role="presentation"
			onMouseDown={closeFromScrim(onClose)}
		>
			<section
				className={cn("app-modal profile-editor-modal")}
				role="dialog"
				aria-modal="true"
			>
				<header className={cn("profile-editor-titlebar")}>
					<h2>编辑资料</h2>
					<button
						className={cn("icon-button profile-editor-close")}
						type="button"
						onClick={onClose}
						title="关闭"
					>
						<X size={22} />
					</button>
				</header>
				<ProfileEditorForm
					user={user}
					onClose={onClose}
					onUserChange={onUserChange}
				/>
			</section>
		</div>
	);
}

export function MobileProfileEditorPage({
	user,
	onClose,
	onUserChange,
}: {
	user: User;
	onClose: () => void;
	onUserChange: (user: User) => void;
}) {
	return (
		<section className={cn("mobile-profile-edit-page")}>
			<header className={cn("mobile-profile-edit-header")}>
				<button
					className={cn("mobile-profile-edit-back")}
					type="button"
					title="返回"
					onClick={onClose}
				>
					<ChevronLeft size={34} />
				</button>
				<strong>编辑资料</strong>
				<span />
			</header>
			<main className={cn("mobile-profile-edit-main")}>
				<ProfileEditorForm
					user={user}
					onClose={onClose}
					onUserChange={onUserChange}
				/>
			</main>
		</section>
	);
}

export function ProfileEditorForm({
	user,
	onClose,
	onUserChange,
}: {
	user: User;
	onClose: () => void;
	onUserChange: (user: User) => void;
}) {
	const initialAvatar = avatarInputFromUrl(user.avatarUrl);
	const [displayName, setDisplayName] = useState(user.displayName);
	const [avatarSource, setAvatarSource] = useState<AvatarSource>(
		initialAvatar.source,
	);
	const [avatarInput, setAvatarInput] = useState(initialAvatar.value);
	const [status, setStatus] = useState("");

	useEffect(() => {
		const nextAvatar = avatarInputFromUrl(user.avatarUrl);
		setDisplayName(user.displayName);
		setAvatarSource(nextAvatar.source);
		setAvatarInput(nextAvatar.value);
	}, [user.avatarUrl, user.displayName]);

	const resolvedAvatarUrl = resolveAvatarUrl(avatarSource, avatarInput);
	const previewAvatarUrl = avatarInput.trim()
		? resolvedAvatarUrl
		: user.avatarUrl;

	function saveAvatar(event: FormEvent) {
		event.preventDefault();
		if (avatarInput.trim() && !resolvedAvatarUrl) {
			setStatus(avatarSourceError(avatarSource));
			return;
		}
		if (!displayName.trim()) {
			setStatus("请输入昵称");
			return;
		}

		onUserChange({
			...user,
			displayName: displayName.trim(),
			avatarUrl: avatarInput.trim() ? resolvedAvatarUrl : user.avatarUrl,
		});
		onClose();
	}

	function clearAvatar() {
		setAvatarSource("github");
		setAvatarInput("");
		onUserChange({ ...user, avatarUrl: null });
		setStatus("头像已删除");
	}

	return (
		<form className={cn("profile-editor-form")} onSubmit={saveAvatar}>
			<div className={cn("profile-editor-avatar")}>
				<Avatar
					name={displayName || displayUserName(user)}
					avatarUrl={previewAvatarUrl}
					seed={user.identityValue}
				/>
			</div>
			<label className={cn("profile-editor-row")}>
				<span>昵称</span>
				<input
					value={displayName}
					onChange={(event) => setDisplayName(event.target.value)}
					placeholder="你的昵称"
					maxLength={32}
				/>
				<em>{displayName.length}/32</em>
			</label>
			<div className={cn("profile-editor-row profile-editor-readonly")}>
				<span>{user.identityLabel}</span>
				<strong>{user.identityValue}</strong>
			</div>
			<div className={cn("profile-editor-source")}>
				<span>头像</span>
				<div
					className={cn("avatar-source-tabs")}
					role="tablist"
					aria-label="头像来源"
				>
					<button
						type="button"
						className={cn(avatarSource === "github" ? "active" : "")}
						onClick={() => setAvatarSource("github")}
					>
						GitHub
					</button>
					<button
						type="button"
						className={cn(avatarSource === "weavatar" ? "active" : "")}
						onClick={() => setAvatarSource("weavatar")}
					>
						WeAvatar
					</button>
				</div>
			</div>
			<label className={cn("profile-editor-row")}>
				<span>{avatarSourceLabel(avatarSource)}</span>
				<input
					value={avatarInput}
					onChange={(event) => setAvatarInput(event.target.value)}
					placeholder={avatarSourcePlaceholder(avatarSource)}
					maxLength={512}
					inputMode="text"
				/>
			</label>
			<p className={cn("profile-editor-note")}>
				头像来自公开 URL，不上传图片；留空时使用默认头像。
			</p>
			<button
				type="button"
				className={cn("text-button danger profile-editor-delete")}
				disabled={!avatarInput && !user.avatarUrl}
				onClick={clearAvatar}
			>
				删除头像
			</button>
			{status ? (
				<p className={cn("form-status profile-editor-status")}>{status}</p>
			) : null}
			<div className={cn("profile-editor-actions")}>
				<button
					type="button"
					className={cn("secondary-button")}
					onClick={onClose}
				>
					取消
				</button>
				<button className={cn("primary-button")}>
					<Check size={18} />
					保存
				</button>
			</div>
		</form>
	);
}
