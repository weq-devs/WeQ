// @ts-nocheck
import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "./classNames";

export function SidebarResizeHandle({
	width,
	onWidthChange,
}: {
	width: number;
	onWidthChange: (width: number) => void;
}) {
	const startX = useRef(0);
	const startWidth = useRef(width);

	function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
		event.preventDefault();
		startX.current = event.clientX;
		startWidth.current = width;
		document.body.classList.add("is-resizing-column");

		function handlePointerMove(moveEvent: globalThis.PointerEvent) {
			onWidthChange(
				clamp(
					startWidth.current + moveEvent.clientX - startX.current,
					220,
					520,
				),
			);
		}

		function handlePointerUp() {
			document.body.classList.remove("is-resizing-column");
			document.removeEventListener("pointermove", handlePointerMove);
			document.removeEventListener("pointerup", handlePointerUp);
		}

		document.addEventListener("pointermove", handlePointerMove);
		document.addEventListener("pointerup", handlePointerUp);
	}

	return (
		<div
			className={cn("sidebar-resize")}
			role="separator"
			aria-label="调整会话列表宽度"
			aria-orientation="vertical"
			onPointerDown={handlePointerDown}
		/>
	);
}
function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}
