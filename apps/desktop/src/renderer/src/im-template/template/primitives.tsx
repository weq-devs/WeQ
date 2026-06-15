// @ts-nocheck
import { useEffect, useState } from "react";
import { cn } from "./classNames";
import { DefaultAvatar } from "./defaultAvatar";

export function Avatar({
	name,
	avatarUrl,
	seed,
}: {
	name: string;
	avatarUrl?: string | null;
	seed?: string;
}) {
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		setFailed(false);
	}, [avatarUrl]);

	return (
		<span
			className={cn(
				"avatar",
				avatarUrl && !failed ? "has-image" : "has-default",
			)}
		>
			{avatarUrl && !failed ? (
				<img
					src={avatarUrl}
					alt=""
					loading="lazy"
					referrerPolicy="no-referrer"
					onError={() => setFailed(true)}
				/>
			) : (
				<DefaultAvatar seed={seed || name} />
			)}
		</span>
	);
}

export function EmptyState({ title, body }: { title: string; body: string }) {
	return (
		<div className={cn("empty-state")}>
			<strong>{title}</strong>
			<span>{body}</span>
		</div>
	);
}

export function ToggleRow({
	label,
	checked,
	onClick,
}: {
	label: string;
	checked: boolean;
	onClick: () => void;
}) {
	return (
		<button
			className={cn("details-toggle-row")}
			type="button"
			role="switch"
			aria-checked={checked}
			onClick={onClick}
		>
			<span>{label}</span>
			<span className={cn(`switch-control ${checked ? "on" : ""}`)}>
				<span />
			</span>
		</button>
	);
}
