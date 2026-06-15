// @ts-nocheck
import { ChevronRight } from "lucide-react";
import { cn } from "./classNames";
import {
	defaultToolRegistry,
	type ToolPaneItem,
	type ToolPaneGroup,
} from "./toolRegistry";

export type { ToolPaneGroup, ToolPaneItem } from "./toolRegistry";

export type ToolPaneEntry = {
	group: ToolPaneGroup;
	item: ToolPaneItem;
};

export function flattenToolRegistry(
	registry: ToolPaneGroup[] = defaultToolRegistry,
	query = "",
): ToolPaneEntry[] {
	const normalizedQuery = query.trim().toLowerCase();

	return registry.flatMap((group) =>
		group.items
			.filter((item) => {
				if (!normalizedQuery) {
					return true;
				}
				return [item.label, item.description]
					.filter(Boolean)
					.some((value) => value?.toLowerCase().includes(normalizedQuery));
			})
			.map((item) => ({ group, item })),
	);
}

export function ToolsPane({
	query,
	registry = defaultToolRegistry,
	activateOnSelect = true,
	onSelectItem,
}: {
	query: string;
	registry?: ToolPaneGroup[];
	activateOnSelect?: boolean;
	onSelectItem?: (item: ToolPaneItem) => void;
}) {
	const normalizedQuery = query.trim().toLowerCase();
	const groups = registry
		.map((group) => ({
			...group,
			items: group.items.filter((item) =>
				item.label.toLowerCase().includes(normalizedQuery),
			),
		}))
		.filter((group) => group.items.length > 0);

	return (
		<section className={cn("tools-pane")}>
			<div className={cn("tools-list")}>
				{groups.map((group) => (
					<div className={cn("tools-group")} key={group.id}>
						{group.label ? (
							<h3 className={cn("tools-group-title")}>{group.label}</h3>
						) : null}
						<div className={cn("tools-group-items")}>
							{group.items.map((item) => {
								const Icon = item.icon;
								return (
									<button
										className={cn("tools-row")}
										type="button"
										key={item.id}
										onClick={() => {
											onSelectItem?.(item);
											if (activateOnSelect) {
												item.onClick?.();
											}
										}}
									>
										<span
											className={cn("tools-row-icon")}
											style={{ color: item.color }}
										>
											<Icon size={28} strokeWidth={2.4} />
										</span>
										<span className={cn("tools-row-main")}>
											<span className={cn("tools-row-label")}>
												{item.label}
											</span>
											{item.description ? (
												<span className={cn("tools-row-description")}>
													{item.description}
												</span>
											) : null}
										</span>
										<span className={cn("tools-row-arrow")}>
											<ChevronRight size={23} color="#9b9da3" />
										</span>
									</button>
								);
							})}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

export function ToolDetailPane({
	query,
	registry = defaultToolRegistry,
	selectedItemId,
	onOpenItem,
	onSelectItem,
}: {
	query: string;
	registry?: ToolPaneGroup[];
	selectedItemId?: string | null;
	onOpenItem?: (item: ToolPaneItem) => void;
	onSelectItem?: (item: ToolPaneItem) => void;
}) {
	const entries = flattenToolRegistry(registry, query);
	const activeEntry =
		entries.find((entry) => entry.item.id === selectedItemId) ?? entries[0];

	if (!activeEntry) {
		return (
			<section className={cn("tools-detail-pane")}>
				<div className={cn("empty-state")}>
					<strong>没有找到应用</strong>
					<span>换个关键词试试。</span>
				</div>
			</section>
		);
	}

	const activeItem = activeEntry.item;
	const ActiveIcon = activeItem.icon;
	const relatedEntries = entries.filter(
		(entry) => entry.group.id === activeEntry.group.id,
	);

	return (
		<section className={cn("tools-detail-pane")}>
			<div className={cn("tools-detail-inner")}>
				<header className={cn("tools-detail-head")}>
					<span
						className={cn("tools-detail-icon")}
						style={{ color: activeItem.color }}
					>
						<ActiveIcon size={48} strokeWidth={2.2} />
					</span>
					<div>
						<span className={cn("tools-detail-kicker")}>
							{activeEntry.group.label ?? "应用"}
						</span>
						<strong>{activeItem.label}</strong>
						{activeItem.description ? <p>{activeItem.description}</p> : null}
					</div>
				</header>

				<div className={cn("tools-detail-fields")}>
					<div className={cn("tools-detail-row")}>
						<span>分类</span>
						<strong>{activeEntry.group.label ?? "应用"}</strong>
					</div>
				</div>

				{activeItem.onClick ? (
					<div className={cn("tools-detail-actions")}>
						<button
							className={cn("primary-button")}
							type="button"
							onClick={() => onOpenItem?.(activeItem)}
						>
							打开
						</button>
					</div>
				) : null}

				{relatedEntries.length > 1 ? (
					<div className={cn("tools-detail-related")}>
						<span>同组应用</span>
						<div>
							{relatedEntries.map((entry) => {
								const Icon = entry.item.icon;
								return (
									<button
										className={cn(entry.item.id === activeItem.id && "active")}
										key={entry.item.id}
										type="button"
										onClick={() => onSelectItem?.(entry.item)}
									>
										<Icon size={20} strokeWidth={2.2} />
										<strong>{entry.item.label}</strong>
									</button>
								);
							})}
						</div>
					</div>
				) : null}
			</div>
		</section>
	);
}
