// @ts-nocheck
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Avatar } from "./primitives";
import type { Contact } from "./types";
import type { GroupConversationView } from "./conversationDetailsTypes";
import { displayUserName } from "./user";
import { cn } from "./classNames";

export function GroupInviteDialog({
	conversation,
	contacts,
	onClose,
	onInvite,
}: {
	conversation: GroupConversationView;
	contacts: Contact[];
	onClose: () => void;
	onInvite: (conversationId: string, memberIds: string[]) => Promise<void>;
}) {
	const [query, setQuery] = useState("");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [status, setStatus] = useState("");
	const [saving, setSaving] = useState(false);
	const memberIds = new Set(conversation.members.map((member) => member.id));
	const candidates = contacts.filter((contact) => !memberIds.has(contact.id));
	const filteredContacts = candidates.filter((contact) => {
		const lower = query.trim().toLowerCase();
		if (!lower) {
			return true;
		}
		return `${displayUserName(contact)} ${contact.username} ${contact.identityValue}`
			.toLowerCase()
			.includes(lower);
	});

	useEffect(() => {
		function closeOnEscape(event: globalThis.KeyboardEvent) {
			if (event.key === "Escape") {
				onClose();
			}
		}

		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [onClose]);

	function toggle(contactId: string) {
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(contactId)) {
				next.delete(contactId);
			} else {
				next.add(contactId);
			}
			return next;
		});
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		const ids = Array.from(selectedIds);
		if (ids.length === 0) {
			setStatus("请选择成员");
			return;
		}

		setSaving(true);
		setStatus("");
		try {
			await onInvite(conversation.id, ids);
			onClose();
		} catch {
			setStatus("邀请失败");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div
			className={cn("modal-scrim subtle")}
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
		>
			<form className={cn("group-invite-dialog")} onSubmit={submit}>
				<header>
					<strong>邀请成员</strong>
					<button
						className={cn("icon-button")}
						type="button"
						onClick={onClose}
						title="关闭"
					>
						×
					</button>
				</header>
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="搜索联系人"
					autoFocus
				/>
				<div className={cn("group-invite-list")}>
					{filteredContacts.length === 0 ? (
						<span className={cn("group-invite-empty")}>暂无可邀请联系人</span>
					) : (
						filteredContacts.map((contact) => {
							const selected = selectedIds.has(contact.id);
							return (
								<button
									key={contact.id}
									type="button"
									className={cn(selected ? "active" : "")}
									onClick={() => toggle(contact.id)}
								>
									<Avatar
										name={displayUserName(contact)}
										avatarUrl={contact.avatarUrl}
										seed={contact.identityValue}
									/>
									<span>{displayUserName(contact)}</span>
									<em>{selected ? "已选" : ""}</em>
								</button>
							);
						})
					)}
				</div>
				<footer>
					<span>
						{status || (selectedIds.size ? `已选 ${selectedIds.size} 人` : "")}
					</span>
					<button
						className={cn("secondary-button")}
						type="button"
						onClick={onClose}
					>
						取消
					</button>
					<button
						className={cn("primary-button")}
						type="submit"
						disabled={saving}
					>
						邀请
					</button>
				</footer>
			</form>
		</div>
	);
}
