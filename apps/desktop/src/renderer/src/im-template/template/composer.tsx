// @ts-nocheck
import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { parseMessageParts } from "./emojiPacks";
import { cn } from "./classNames";

export type ComposerMentionTrigger = {
	start: number;
	end: number;
	query: string;
};

export function insertComposerNode(
	editor: HTMLElement,
	node: Node,
	savedRange: Range | null,
) {
	editor.focus();

	const range = getComposerRange(editor, savedRange);
	range.deleteContents();
	range.insertNode(node);
	range.setStartAfter(node);
	range.collapse(true);

	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

function getComposerRange(editor: HTMLElement, savedRange: Range | null) {
	const selection = window.getSelection();
	if (selection?.rangeCount) {
		const activeRange = selection.getRangeAt(0);
		if (
			isNodeInside(editor, activeRange.startContainer) &&
			isNodeInside(editor, activeRange.endContainer)
		) {
			return activeRange;
		}
	}

	if (
		savedRange &&
		isNodeInside(editor, savedRange.startContainer) &&
		isNodeInside(editor, savedRange.endContainer)
	) {
		return savedRange.cloneRange();
	}

	const range = document.createRange();
	range.selectNodeContents(editor);
	range.collapse(false);
	return range;
}

export function focusComposerEnd(editor: HTMLElement | null) {
	if (!editor) {
		return;
	}

	editor.focus();
	const range = document.createRange();
	range.selectNodeContents(editor);
	range.collapse(false);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

export function serializeComposer(editor: HTMLElement) {
	return serializeComposerNode(editor)
		.replace(/\u200b/g, "")
		.slice(0, 4000);
}

export function getActiveComposerMentionTrigger(
	editor: HTMLElement,
	savedRange: Range | null,
): ComposerMentionTrigger | null {
	const range = getReadableComposerRange(editor, savedRange);
	if (!range) {
		return null;
	}

	const beforeRange = document.createRange();
	beforeRange.selectNodeContents(editor);
	beforeRange.setEnd(range.startContainer, range.startOffset);
	const before = serializeComposerNode(beforeRange.cloneContents()).replace(
		/\u200b/g,
		"",
	);
	const match = /(^|[\s\n])@([^\s@\n]{0,40})$/u.exec(before);
	if (!match) {
		return null;
	}

	const query = match[2] ?? "";
	return {
		start: before.length - query.length - 1,
		end: before.length,
		query,
	};
}

export function replaceComposerTextRange(
	editor: HTMLElement,
	start: number,
	end: number,
	nodes: Node[],
) {
	editor.focus();

	const startPosition = resolveComposerTextOffset(editor, start);
	const endPosition = resolveComposerTextOffset(editor, end);
	const range = document.createRange();
	range.setStart(startPosition.node, startPosition.offset);
	range.setEnd(endPosition.node, endPosition.offset);
	range.deleteContents();

	nodes.forEach((node) => {
		range.insertNode(node);
		range.setStartAfter(node);
	});
	range.collapse(true);

	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

export function restoreComposer(editor: HTMLElement, value: string) {
	editor.replaceChildren();

	parseMessageParts(value).forEach((part) => {
		if (part.type === "text") {
			appendText(editor, part.value);
			return;
		}

		const image = document.createElement("img");
		image.src = part.item.value;
		image.alt = `[${part.item.name}]`;
		image.title = part.item.name;
		image.draggable = false;
		image.dataset.chatToken = part.raw;
		image.className = cn(
			part.item.large
				? "composer-token-image composer-sticker-token"
				: "composer-token-image composer-inline-emoji",
		);
		editor.append(image);
	});
}

function serializeComposerNode(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return node.textContent ?? "";
	}

	if (node instanceof DocumentFragment) {
		return Array.from(node.childNodes).map(serializeComposerNode).join("");
	}

	if (node instanceof HTMLImageElement) {
		return node.dataset.chatToken ?? "";
	}

	if (node instanceof HTMLBRElement) {
		return "\n";
	}

	if (!(node instanceof HTMLElement)) {
		return "";
	}

	if (node.dataset.chatMention) {
		return node.dataset.chatMention;
	}

	return Array.from(node.childNodes).map(serializeComposerNode).join("");
}

function getReadableComposerRange(
	editor: HTMLElement,
	savedRange: Range | null,
) {
	const selection = window.getSelection();
	if (selection?.rangeCount) {
		const activeRange = selection.getRangeAt(0);
		if (
			isNodeInside(editor, activeRange.startContainer) &&
			isNodeInside(editor, activeRange.endContainer)
		) {
			return activeRange.cloneRange();
		}
	}

	if (
		savedRange &&
		isNodeInside(editor, savedRange.startContainer) &&
		isNodeInside(editor, savedRange.endContainer)
	) {
		return savedRange.cloneRange();
	}

	return null;
}

function resolveComposerTextOffset(editor: HTMLElement, offset: number) {
	const target = Math.max(0, offset);
	let current = 0;

	function walk(node: Node): { node: Node; offset: number } | null {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = (node.textContent ?? "").replace(/\u200b/g, "");
			const next = current + text.length;
			if (target <= next) {
				return {
					node,
					offset: Math.max(
						0,
						Math.min(node.textContent?.length ?? 0, target - current),
					),
				};
			}
			current = next;
			return null;
		}

		const atomicText = composerAtomicText(node);
		if (atomicText !== null) {
			if (target <= current) {
				return nodeBoundaryPosition(node, "before");
			}
			current += atomicText.length;
			if (target <= current) {
				return nodeBoundaryPosition(node, "after");
			}
			return null;
		}

		for (const child of Array.from(node.childNodes)) {
			const result = walk(child);
			if (result) {
				return result;
			}
		}

		return null;
	}

	return (
		walk(editor) ?? {
			node: editor,
			offset: editor.childNodes.length,
		}
	);
}

function composerAtomicText(node: Node) {
	if (node instanceof HTMLImageElement) {
		return node.dataset.chatToken ?? "";
	}
	if (node instanceof HTMLBRElement) {
		return "\n";
	}
	if (node instanceof HTMLElement && node.dataset.chatMention) {
		return node.dataset.chatMention;
	}
	return null;
}

function nodeBoundaryPosition(node: Node, boundary: "before" | "after") {
	const parent = node.parentNode;
	if (!parent) {
		return {
			node,
			offset: 0,
		};
	}

	const index = Array.prototype.indexOf.call(parent.childNodes, node) as number;
	return {
		node: parent,
		offset: boundary === "before" ? index : index + 1,
	};
}

function appendText(editor: HTMLElement, value: string) {
	const lines = value.split("\n");
	lines.forEach((line, index) => {
		if (index > 0) {
			editor.append(document.createElement("br"));
		}
		if (line) {
			editor.append(document.createTextNode(line));
		}
	});
}

export function isNodeInside(parent: Node, child: Node) {
	return parent === child || parent.contains(child);
}

export function ComposerResizeHandle({
	height,
	onHeightChange,
}: {
	height: number;
	onHeightChange: (height: number) => void;
}) {
	const startY = useRef(0);
	const startHeight = useRef(height);

	function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
		event.preventDefault();
		startY.current = event.clientY;
		startHeight.current = height;
		document.body.classList.add("is-resizing-composer");

		function handlePointerMove(moveEvent: globalThis.PointerEvent) {
			onHeightChange(
				clamp(
					startHeight.current - (moveEvent.clientY - startY.current),
					150,
					340,
				),
			);
		}

		function handlePointerUp() {
			document.body.classList.remove("is-resizing-composer");
			document.removeEventListener("pointermove", handlePointerMove);
			document.removeEventListener("pointerup", handlePointerUp);
		}

		document.addEventListener("pointermove", handlePointerMove);
		document.addEventListener("pointerup", handlePointerUp);
	}

	return (
		<div
			className={cn("composer-resize")}
			role="separator"
			aria-label="调整输入框高度"
			aria-orientation="horizontal"
			onPointerDown={handlePointerDown}
		/>
	);
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}
