// @ts-nocheck
import type { Message } from "./types";
import { cn } from "./classNames";

/**
 * A run of messages QQ never synced to this device. Rendered between the two
 * messages that straddle the hole.
 */
export function MessageGapDivider({ count }: { count: number }) {
	return (
		<div className={cn("weq-graytip-band")}>
			<div className={cn("weq-graytip-band-hint")}>
				此处有 {count} 条消息未同步 · 用 QQ 查看后会自动补全
			</div>
		</div>
	);
}

/**
 * How many messages are missing between `previous` and `current`, or 0 when
 * they are adjacent.
 *
 * The per-conversation sequence (SQL column 40003) increments once per message.
 * Gray tips are the one wrinkle: they reuse the seq of the message they hang
 * off, so a seq can repeat — but it never *skips*. That makes a jump of more
 * than 1 proof that the seqs in between hold no row at all, i.e. QQ has those
 * messages server-side but never synced them here.
 *
 * Messages imported from a phone carry no seq (0); they are skipped rather than
 * treated as a hole reaching back to the start of the conversation.
 */
export function messageGapCount(
	previous: Message | undefined,
	current: Message,
): number {
	if (!previous) {
		return 0;
	}

	const previousSeq = toSeq(previous.msgSeq);
	const currentSeq = toSeq(current.msgSeq);
	if (previousSeq === null || currentSeq === null) {
		return 0;
	}

	const missing = currentSeq - previousSeq - 1n;
	return missing > 0n ? Number(missing) : 0;
}

/** Parse a seq to bigint; null for absent, unparsable, or the 0 placeholder. */
function toSeq(value: unknown): bigint | null {
	if (typeof value !== "string" || value === "") {
		return null;
	}
	try {
		const seq = BigInt(value);
		return seq > 0n ? seq : null;
	} catch {
		return null;
	}
}
