// @ts-nocheck
import { Smile } from "lucide-react";
import type { RefObject } from "react";
import { emojiPacks } from "./emojiPacks";
import type { EmojiItem, EmojiPack } from "./emojiPacks";
import { cn } from "./classNames";

export function EmojiPanel({
	panelRef,
	activePackId,
	onActivePackChange,
	onSelect,
}: {
	panelRef: RefObject<HTMLDivElement | null>;
	activePackId: string;
	onActivePackChange: (packId: string) => void;
	onSelect: (item: EmojiItem) => void;
}) {
	const activePack =
		emojiPacks.find((pack) => pack.id === activePackId) ?? emojiPacks[0];

	return (
		<div className={cn("emoji-panel")} ref={panelRef} aria-label="表情面板">
			<div className={cn("emoji-panel-body")}>
				{activePack.id === "emoji" ? (
					<>
						<EmojiSection
							title="最近表情"
							items={activePack.items.slice(0, 20)}
							onSelect={onSelect}
						/>
						<EmojiSection
							title="表情"
							items={activePack.items}
							onSelect={onSelect}
						/>
					</>
				) : activePack.type === "text" ? (
					<KaomojiSection pack={activePack} onSelect={onSelect} />
				) : (
					<EmojiSection
						title={activePack.name}
						items={activePack.items}
						onSelect={onSelect}
					/>
				)}
			</div>
			<div className={cn("emoji-tabs")}>
				{emojiPacks.map((pack) => (
					<button
						key={pack.id}
						type="button"
						className={cn(pack.id === activePack.id ? "active" : "")}
						title={pack.name}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => onActivePackChange(pack.id)}
					>
						<EmojiTabPreview pack={pack} />
					</button>
				))}
			</div>
		</div>
	);
}

function EmojiSection({
	title,
	items,
	onSelect,
}: {
	title: string;
	items: EmojiItem[];
	onSelect: (item: EmojiItem) => void;
}) {
	const large = items.some((item) => item.large);

	return (
		<section className={cn("emoji-section")}>
			<h3>{title}</h3>
			<div className={cn(`emoji-grid ${large ? "sticker-grid" : ""}`)}>
				{items.map((item) => (
					<button
						key={`${item.packId}-${item.id}`}
						type="button"
						title={item.name}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => onSelect(item)}
					>
						<img src={item.value} alt={item.name} draggable={false} />
					</button>
				))}
			</div>
		</section>
	);
}

function KaomojiSection({
	pack,
	onSelect,
}: {
	pack: EmojiPack;
	onSelect: (item: EmojiItem) => void;
}) {
	return (
		<section className={cn("emoji-section")}>
			<h3>{pack.name}</h3>
			<div className={cn("kaomoji-grid")}>
				{pack.items.map((item) => (
					<button
						key={`${item.packId}-${item.id}`}
						type="button"
						title={item.name}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => onSelect(item)}
					>
						<span>{item.name}</span>
						<strong>{item.value}</strong>
					</button>
				))}
			</div>
		</section>
	);
}

function EmojiTabPreview({ pack }: { pack: EmojiPack }) {
	if (pack.id === "emoji") {
		return <Smile size={23} />;
	}

	if (pack.type === "text") {
		return <span className={cn("emoji-tab-text")}>颜</span>;
	}

	const preview = pack.items[0];
	return preview ? (
		<img src={preview.value} alt={pack.name} draggable={false} />
	) : null;
}
