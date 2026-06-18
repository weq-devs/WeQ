import { Copy, Download, Trash2, Edit3 } from "lucide-react";
import type { Message } from "./types";
import { cn } from "./classNames";

export type MessageContextMenuState = {
	message: Message;
	x: number;
	y: number;
	downloadUrl?: string;
	variant?: "desktop" | "mobile";
};

export function MessageContextMenu({
	state,
	onCopy,
	onDownloadImage,
	onDeleteLocal,
	onEditRaw,
}: {
	state: MessageContextMenuState;
	onCopy: (message: Message) => void | Promise<void>;
	onDownloadImage?: (url: string, message: Message) => void;
	onDeleteLocal: (message: Message) => void;
	onEditRaw?: (message: Message) => void;
}) {
	return (
		<div
			className={cn(
				"message-context-menu",
				state.variant === "mobile" && "message-context-menu-mobile",
				state.downloadUrl && "message-context-menu-has-download",
			)}
			style={
				state.variant === "mobile"
					? { left: state.x, top: state.y, transform: "translateX(-50%)" }
					: { left: state.x, top: state.y }
			}
			onMouseDown={(event) => {
				event.preventDefault();
				event.stopPropagation();
			}}
			onPointerDown={(event) => event.stopPropagation()}
			onTouchStart={(event) => event.stopPropagation()}
		>
			<button type="button" onClick={() => void onCopy(state.message)}>
				<Copy size={17} />
				<span>复制</span>
			</button>
			{onEditRaw ? (
				<button type="button" onClick={() => onEditRaw(state.message)}>
					<Edit3 size={17} />
					<span>修改</span>
				</button>
			) : null}
			{state.downloadUrl && onDownloadImage ? (
				<button
					type="button"
					onClick={() =>
						onDownloadImage(state.downloadUrl ?? "", state.message)
					}
				>
					<Download size={17} />
					<span>下载</span>
				</button>
			) : null}
			<button type="button" onClick={() => onDeleteLocal(state.message)}>
				<Trash2 size={17} />
				<span>删除</span>
			</button>
		</div>
	);
}
