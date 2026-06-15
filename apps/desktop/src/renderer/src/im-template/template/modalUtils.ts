// @ts-nocheck
import { useEffect } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

export function closeFromScrim(onClose: () => void) {
	return (event: ReactMouseEvent<HTMLDivElement>) => {
		if (event.target === event.currentTarget) {
			onClose();
		}
	};
}

export function useEscapeToClose(onClose: () => void) {
	useEffect(() => {
		function closeOnEscape(event: globalThis.KeyboardEvent) {
			if (event.key === "Escape") {
				onClose();
			}
		}

		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [onClose]);
}
