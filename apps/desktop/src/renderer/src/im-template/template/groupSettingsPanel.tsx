// @ts-nocheck
import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { DesktopDetailActionGroups } from "./conversationDetailActionRows";
import type {
	ConversationDetailActionContext,
	ConversationDetailActionGroup,
} from "./conversationDetailActions";
import { Avatar } from "./primitives";
import type {
	GroupConversationView,
	GroupUpdateInput,
} from "./conversationDetailsTypes";
import { cn } from "./classNames";

export function GroupSettingsPanel({
	conversation,
	panelRef,
	onUpdateGroup,
	detailActionGroups,
	detailActionContext,
}: {
	conversation: GroupConversationView;
	panelRef: RefObject<HTMLElement | null>;
	onUpdateGroup: (
		conversationId: string,
		input: GroupUpdateInput,
	) => Promise<void>;
	detailActionGroups: ConversationDetailActionGroup[];
	detailActionContext: ConversationDetailActionContext;
}) {
	const canManage = conversation.group.role !== "member";
	const initialAvatar = groupAvatarInputFromUrl(conversation.group.avatarUrl);
	const [name, setName] = useState(conversation.group.name);
	const [announcement, setAnnouncement] = useState(
		conversation.group.announcement ?? "",
	);
	const [avatarSource, setAvatarSource] = useState<"github" | "weavatar">(
		initialAvatar.source,
	);
	const [avatarRef, setAvatarRef] = useState(initialAvatar.ref);
	const [status, setStatus] = useState("");
	const [saving, setSaving] = useState(false);
	const [profileEditing, setProfileEditing] = useState(false);

	useEffect(() => {
		const nextAvatar = groupAvatarInputFromUrl(conversation.group.avatarUrl);
		setName(conversation.group.name);
		setAnnouncement(conversation.group.announcement ?? "");
		setAvatarSource(nextAvatar.source);
		setAvatarRef(nextAvatar.ref);
		setStatus("");
		setSaving(false);
		setProfileEditing(false);
	}, [
		conversation.id,
		conversation.group.name,
		conversation.group.announcement,
		conversation.group.avatarUrl,
	]);

	async function saveProfile() {
		const nextName = name.trim();
		if (!nextName) {
			setStatus("群名称不能为空");
			return;
		}

		setSaving(true);
		setStatus("");
		try {
			await onUpdateGroup(conversation.id, {
				name: nextName,
				announcement: announcement.trim() || null,
			});
			setStatus("已保存");
			setProfileEditing(false);
		} catch {
			setStatus("保存失败");
		} finally {
			setSaving(false);
		}
	}

	async function saveAvatar() {
		const ref = avatarRef.trim();
		if (!ref) {
			setStatus(
				avatarSource === "github" ? "请输入 GitHub 用户名" : "请输入 32 位 MD5",
			);
			return;
		}

		setSaving(true);
		setStatus("");
		try {
			await onUpdateGroup(conversation.id, {
				avatar: {
					source: avatarSource,
					ref,
				},
			});
			setStatus("头像已更新");
		} catch {
			setStatus("头像更新失败");
		} finally {
			setSaving(false);
		}
	}

	async function clearAvatar() {
		setSaving(true);
		setStatus("");
		try {
			await onUpdateGroup(conversation.id, {
				avatar: {
					source: "none",
				},
			});
			setAvatarRef("");
			setStatus("头像已清除");
		} catch {
			setStatus("头像清除失败");
		} finally {
			setSaving(false);
		}
	}

	function cancelProfileEdit() {
		setName(conversation.group.name);
		setAnnouncement(conversation.group.announcement ?? "");
		setStatus("");
		setProfileEditing(false);
	}

	return (
		<aside
			className={cn("conversation-details group-settings-panel")}
			ref={panelRef}
			aria-label="群聊设置"
		>
			<div className={cn("conversation-details-profile")}>
				<Avatar
					name={conversation.group.name}
					avatarUrl={conversation.group.avatarUrl}
					seed={conversation.id}
				/>
				<strong>{conversation.group.name}</strong>
				<span>{conversation.group.memberCount} 位成员</span>
			</div>

			{canManage && !profileEditing ? (
				<section
					className={cn("details-card group-edit-card group-edit-preview")}
				>
					<div className={cn("group-edit-card-header")}>
						<strong>群资料</strong>
						<button
							className={cn("group-edit-icon-button")}
							type="button"
							title="编辑群资料"
							onClick={() => setProfileEditing(true)}
						>
							<Pencil size={16} />
						</button>
					</div>
					<div className={cn("group-edit-preview-list")}>
						<div className={cn("group-edit-preview-row")}>
							<span>群名称</span>
							<strong>{conversation.group.name}</strong>
						</div>
						<div className={cn("group-edit-preview-row")}>
							<span>群公告</span>
							<p>{conversation.group.announcement?.trim() || "未设置"}</p>
						</div>
					</div>
				</section>
			) : null}

			{canManage && profileEditing ? (
				<section className={cn("details-card group-edit-card")}>
					<div className={cn("group-edit-card-header")}>
						<strong>编辑群资料</strong>
					</div>
					<label className={cn("group-edit-field")}>
						<span>群名称</span>
						<input
							value={name}
							maxLength={40}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<label className={cn("group-edit-field")}>
						<span>群公告</span>
						<textarea
							value={announcement}
							maxLength={600}
							rows={4}
							onChange={(event) => setAnnouncement(event.target.value)}
						/>
					</label>
					<div className={cn("group-edit-actions")}>
						<button type="button" disabled={saving} onClick={cancelProfileEdit}>
							取消
						</button>
						<button
							className={cn("primary-button")}
							type="button"
							disabled={saving}
							onClick={saveProfile}
						>
							保存资料
						</button>
					</div>
				</section>
			) : null}

			{canManage ? (
				<section className={cn("details-card group-avatar-settings")}>
					<div className={cn("group-avatar-tabs")}>
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
					<input
						value={avatarRef}
						onChange={(event) => setAvatarRef(event.target.value)}
						placeholder={
							avatarSource === "github"
								? "输入 GitHub 用户名"
								: "输入 32 位 MD5"
						}
					/>
					<div className={cn("group-avatar-actions")}>
						<button type="button" disabled={saving} onClick={clearAvatar}>
							清除
						</button>
						<button
							className={cn("primary-button")}
							type="button"
							disabled={saving}
							onClick={saveAvatar}
						>
							保存头像
						</button>
					</div>
				</section>
			) : null}

			{status ? (
				<span className={cn("form-status compact")}>{status}</span>
			) : null}

			<DesktopDetailActionGroups
				groups={detailActionGroups}
				context={detailActionContext}
			/>
		</aside>
	);
}

function groupAvatarInputFromUrl(avatarUrl: string | null | undefined): {
	source: "github" | "weavatar";
	ref: string;
} {
	if (!avatarUrl) {
		return {
			source: "github",
			ref: "",
		};
	}

	const github = avatarUrl.match(
		/^https:\/\/github\.com\/([a-zA-Z0-9-]+)\.png\?size=240$/,
	);
	if (github?.[1]) {
		return {
			source: "github",
			ref: github[1],
		};
	}

	const githubAvatar = avatarUrl.match(
		/^https:\/\/avatars\.githubusercontent\.com\/([a-zA-Z0-9-]+)\?s=240$/,
	);
	if (githubAvatar?.[1]) {
		return {
			source: "github",
			ref: githubAvatar[1],
		};
	}

	const weavatarMatch = avatarUrl.match(
		/^https:\/\/weavatar\.com\/avatar\/([a-fA-F0-9]{32})/,
	);
	if (weavatarMatch) {
		return {
			source: "weavatar",
			ref: weavatarMatch[1].toLowerCase(),
		};
	}

	return {
		source: "github",
		ref: "",
	};
}
