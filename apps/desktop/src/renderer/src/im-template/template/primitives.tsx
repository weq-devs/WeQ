// @ts-nocheck
import { useEffect, useState } from "react";
import { cn } from "./classNames";
import { DefaultAvatar } from "./defaultAvatar";
import { cachedAvatarUrl } from "../../lib/avatarCache";

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
	const resolved = cachedAvatarUrl(avatarUrl);

	useEffect(() => {
		setFailed(false);
	}, [avatarUrl]);

	return (
		<span
			className={cn(
				"avatar",
				resolved && !failed ? "has-image" : "has-default",
			)}
		>
			{resolved && !failed ? (
				<img
					src={resolved}
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
