// @ts-nocheck
import { Check, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { cn } from "./classNames";
import { closeFromScrim, useEscapeToClose } from "./modalUtils";
import { Avatar, EmptyState } from "./primitives";
import type { Contact, Conversation, User } from "./types";
import { displayUserName } from "./user";

type AddSearchMode = "users" | "groups";

export function AddContactModal({
	user,
	contacts,
	conversations,
	onClose,
	onOpenConversation,
}: {
	user: User;
	contacts: Contact[];
	conversations: Conversation[];
	onClose: () => void;
	onOpenConversation: (conversationId: string) => void;
}) {
	const [mode, setMode] = useState<AddSearchMode>("users");
	const [query, setQuery] = useState("");
	const [searched, setSearched] = useState(false);
	const [status, setStatus] = useState("");
	useEscapeToClose(onClose);

	const identifier = query.trim();
	const contactResult = useMemo(() => {
		if (!identifier || mode !== "users") {
			return null;
		}
		if (identifier === user.identityValue) {
			return { kind: "self" as const, user };
		}
		const contact = contacts.find((item) => item.identityValue === identifier);
		if (!contact) {
			return null;
		}
		const conversation = conversations.find(
			(item) => item.type === "direct" && item.otherUser.id === contact.id,
		);
		return {
			kind: "contact" as const,
			user: contact,
			conversationId: conversation?.id ?? null,
		};
	}, [contacts, conversations, identifier, mode, user]);

	const groupResult = useMemo(() => {
		if (!identifier || mode !== "groups") {
			return null;
		}
		return (
			conversations.find(
				(item) =>
					item.type === "group" && item.group.identityValue === identifier,
			) ?? null
		);
	}, [conversations, identifier, mode]);

	useEffect(() => {
		setSearched(false);
		setStatus("");
	}, [identifier, mode]);

	useEffect(() => {
		if (!/^[0-9]{2,14}$/.test(identifier)) {
			return;
		}
		const timer = window.setTimeout(() => {
			setSearched(true);
			setStatus(
				searchStatus(
					mode,
					Boolean(contactResult),
					Boolean(groupResult),
					contactResult?.kind,
				),
			);
		}, 220);
		return () => window.clearTimeout(timer);
	}, [contactResult, groupResult, identifier, mode]);

	function search(event: FormEvent) {
		event.preventDefault();
		setSearched(true);
		if (!/^[0-9]{2,14}$/.test(identifier)) {
			setStatus(mode === "groups" ? "请输入群号" : "请输入用户 ID");
			return;
		}
		setStatus(
			searchStatus(
				mode,
				Boolean(contactResult),
				Boolean(groupResult),
				contactResult?.kind,
			),
		);
	}

	function openConversation(conversationId: string | null | undefined) {
		if (!conversationId) {
			return;
		}
		onOpenConversation(conversationId);
		onClose();
	}

	return (
		<div
			className={cn("modal-scrim")}
			role="presentation"
			onMouseDown={closeFromScrim(onClose)}
		>
			<section
				className={cn("app-modal add-contact-modal")}
				role="dialog"
				aria-modal="true"
			>
				<header className={cn("modal-titlebar")}>
					<div>
						<h2>添加联系人</h2>
					</div>
					<button
						className={cn("icon-button")}
						type="button"
						onClick={onClose}
						title="关闭"
					>
						<X size={22} />
					</button>
				</header>
				<main className={cn("add-contact-main")}>
					<form className={cn("global-search-box")} onSubmit={search}>
						<Search size={23} />
						<input
							autoFocus
							inputMode="numeric"
							placeholder={mode === "groups" ? "输入群号" : "输入用户 ID"}
							value={query}
							onChange={(event) =>
								setQuery(event.target.value.replace(/\D/g, ""))
							}
						/>
						{query ? (
							<button
								className={cn("icon-button")}
								type="button"
								title="清空"
								onClick={() => setQuery("")}
							>
								<X size={20} />
							</button>
						) : null}
					</form>

					<nav className={cn("global-search-tabs")} aria-label="搜索类型">
						<button
							className={cn(mode === "users" && "active")}
							type="button"
							onClick={() => setMode("users")}
						>
							用户
						</button>
						<button
							className={cn(mode === "groups" && "active")}
							type="button"
							onClick={() => setMode("groups")}
						>
							群聊
						</button>
					</nav>

					<section className={cn("add-contact-results")}>
						{mode === "users" && contactResult ? (
							<div className={cn("search-user-row")}>
								<Avatar
									name={displayUserName(contactResult.user)}
									avatarUrl={contactResult.user.avatarUrl}
									seed={contactResult.user.identityValue}
								/>
								<div>
									<strong>{displayUserName(contactResult.user)}</strong>
									<span className={cn("copyable-text")}>
										ID {contactResult.user.identityValue}
									</span>
								</div>
								<button
									className={cn("secondary-button")}
									type="button"
									disabled={
										contactResult.kind === "self" ||
										!("conversationId" in contactResult)
									}
									onClick={() => {
										if ("conversationId" in contactResult) {
											openConversation(contactResult.conversationId);
										}
									}}
								>
									{contactResult.kind === "self" ? "这是你自己" : "发消息"}
								</button>
							</div>
						) : null}

						{mode === "groups" && groupResult?.type === "group" ? (
							<div className={cn("search-user-row search-group-row")}>
								<Avatar
									name={groupResult.group.name}
									avatarUrl={groupResult.group.avatarUrl}
									seed={groupResult.group.identityValue}
								/>
								<div>
									<strong>{groupResult.group.name}</strong>
									<span className={cn("copyable-text")}>
										群号 {groupResult.group.identityValue}
									</span>
								</div>
								<button
									className={cn("secondary-button")}
									type="button"
									onClick={() => openConversation(groupResult.id)}
								>
									进入群聊
								</button>
							</div>
						) : null}

						{!contactResult && !groupResult ? (
							<EmptyState
								title={
									searched || status
										? status ||
											(mode === "groups"
												? "没有找到这个群聊"
												: "没有找到这个 ID")
										: mode === "groups"
											? "按群号查找群聊"
											: "按 ID 查找联系人"
								}
								body={
									mode === "groups"
										? "输入群号，然后按 Enter。"
										: "输入用户 ID，然后按 Enter。"
								}
							/>
						) : null}
					</section>

					{status ? (
						<p className={cn("form-status add-contact-status")}>{status}</p>
					) : null}
				</main>
			</section>
		</div>
	);
}

export function CreateGroupModal({
	contacts,
	onClose,
	onCreate,
}: {
	contacts: Contact[];
	onClose: () => void;
	onCreate: (name: string, memberIds: string[]) => void;
}) {
	const [name, setName] = useState("");
	const [query, setQuery] = useState("");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [status, setStatus] = useState("");
	useEscapeToClose(onClose);

	const filteredContacts = useMemo(() => {
		const lower = query.trim().toLowerCase();
		if (!lower) {
			return contacts;
		}
		return contacts.filter((contact) =>
			`${displayUserName(contact)} ${contact.username} ${contact.identityValue}`
				.toLowerCase()
				.includes(lower),
		);
	}, [contacts, query]);

	function toggleContact(contactId: string) {
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

	function submit(event: FormEvent) {
		event.preventDefault();
		const nextName = name.trim();
		const memberIds = Array.from(selectedIds);
		if (!nextName) {
			setStatus("请输入群聊名称");
			return;
		}
		if (memberIds.length === 0) {
			setStatus("至少选择一位联系人");
			return;
		}
		onCreate(nextName, memberIds);
		onClose();
	}

	return (
		<div
			className={cn("modal-scrim")}
			role="presentation"
			onMouseDown={closeFromScrim(onClose)}
		>
			<section
				className={cn("app-modal create-group-modal")}
				role="dialog"
				aria-modal="true"
			>
				<header className={cn("modal-titlebar")}>
					<div>
						<h2>创建群聊</h2>
					</div>
					<button
						className={cn("icon-button")}
						type="button"
						onClick={onClose}
						title="关闭"
					>
						<X size={22} />
					</button>
				</header>
				<form className={cn("create-group-form")} onSubmit={submit}>
					<label className={cn("form-field")}>
						<span>群名称</span>
						<input
							autoFocus
							maxLength={40}
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<label className={cn("global-search-box create-group-search")}>
						<Search size={22} />
						<input
							placeholder="搜索联系人"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<div className={cn("create-group-list")}>
						{filteredContacts.length === 0 ? (
							<EmptyState title="暂无联系人" body="换个关键词试试。" />
						) : (
							filteredContacts.map((contact) => {
								const selected = selectedIds.has(contact.id);
								return (
									<button
										key={contact.id}
										type="button"
										className={cn("create-group-contact", selected && "active")}
										onClick={() => toggleContact(contact.id)}
									>
										<Avatar
											name={displayUserName(contact)}
											avatarUrl={contact.avatarUrl}
											seed={contact.identityValue}
										/>
										<span>
											<strong>{displayUserName(contact)}</strong>
											<small>ID {contact.identityValue}</small>
										</span>
										<span className={cn("create-group-check")}>
											{selected ? <Check size={16} /> : null}
										</span>
									</button>
								);
							})
						)}
					</div>
					<footer className={cn("modal-actions")}>
						<span>
							{selectedIds.size ? `已选择 ${selectedIds.size} 人` : status}
						</span>
						<button
							className={cn("secondary-button")}
							type="button"
							onClick={onClose}
						>
							取消
						</button>
						<button className={cn("primary-button")} type="submit">
							创建
						</button>
					</footer>
					{status && selectedIds.size > 0 ? (
						<p className={cn("form-status")}>{status}</p>
					) : null}
				</form>
			</section>
		</div>
	);
}

function searchStatus(
	mode: AddSearchMode,
	hasContact: boolean,
	hasGroup: boolean,
	contactKind?: "self" | "contact",
) {
	if (mode === "groups") {
		return hasGroup ? "" : "没有找到这个群聊";
	}
	if (contactKind === "self") {
		return "";
	}
	return hasContact ? "" : "没有找到这个 ID";
}
