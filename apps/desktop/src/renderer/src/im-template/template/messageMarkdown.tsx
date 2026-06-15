// @ts-nocheck
import { Fragment } from "react";
import type { ReactNode } from "react";
import { parseMessageParts } from "./emojiPacks";
import type { EmojiItem } from "./emojiPacks";
import { cn } from "./classNames";

export type MarkdownBlock =
	| {
			type: "paragraph";
			text: string;
	  }
	| {
			type: "quote";
			text: string;
	  }
	| {
			type: "list";
			ordered: boolean;
			items: string[];
	  }
	| {
			type: "code";
			language: string;
			text: string;
	  };

export function parseMarkdownBlocks(value: string): MarkdownBlock[] {
	const lines = value.replace(/\r\n/g, "\n").split("\n");
	const blocks: MarkdownBlock[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];

		if (!line.trim()) {
			index += 1;
			continue;
		}

		const fence = line.match(/^```([\w-]*)\s*$/);
		if (fence) {
			const codeLines: string[] = [];
			index += 1;
			while (index < lines.length && !lines[index].startsWith("```")) {
				codeLines.push(lines[index]);
				index += 1;
			}
			if (index < lines.length) {
				index += 1;
			}
			blocks.push({
				type: "code",
				language: fence[1] ?? "",
				text: codeLines.join("\n"),
			});
			continue;
		}

		if (/^>\s?/.test(line)) {
			const quoteLines: string[] = [];
			while (index < lines.length && /^>\s?/.test(lines[index])) {
				quoteLines.push(lines[index].replace(/^>\s?/, ""));
				index += 1;
			}
			blocks.push({
				type: "quote",
				text: quoteLines.join("\n"),
			});
			continue;
		}

		const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
		if (listMatch) {
			const ordered = /\d+[.)]/.test(listMatch[2]);
			const items: string[] = [];
			while (index < lines.length) {
				const currentMatch = lines[index].match(
					/^(\s*)([-*+]|\d+[.)])\s+(.+)$/,
				);
				if (!currentMatch || /\d+[.)]/.test(currentMatch[2]) !== ordered) {
					break;
				}
				items.push(currentMatch[3]);
				index += 1;
			}
			blocks.push({
				type: "list",
				ordered,
				items,
			});
			continue;
		}

		const paragraphLines: string[] = [];
		while (
			index < lines.length &&
			lines[index].trim() &&
			!/^```/.test(lines[index]) &&
			!/^>\s?/.test(lines[index]) &&
			!/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[index])
		) {
			paragraphLines.push(lines[index]);
			index += 1;
		}
		blocks.push({
			type: "paragraph",
			text: paragraphLines.join("\n"),
		});
	}

	return blocks.length > 0 ? blocks : [{ type: "paragraph", text: value }];
}

export function renderInlineMarkdown(value: string, keyPrefix: string) {
	const nodes: ReactNode[] = [];
	const parts = parseMessageParts(value);

	parts.forEach((part, partIndex) => {
		if (part.type === "emoji") {
			nodes.push(
				renderEmojiImage(part.item, `${keyPrefix}-emoji-${partIndex}`),
			);
			return;
		}

		nodes.push(
			...renderMarkdownText(part.value, `${keyPrefix}-text-${partIndex}`),
		);
	});

	return nodes;
}

function renderMarkdownText(value: string, keyPrefix: string) {
	const nodes: ReactNode[] = [];
	const pattern =
		/!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~/gi;
	let cursor = 0;
	let match: RegExpExecArray | null = pattern.exec(value);

	while (match) {
		if (match.index > cursor) {
			nodes.push(
				...renderPlainText(
					value.slice(cursor, match.index),
					`${keyPrefix}-${cursor}`,
				),
			);
		}

		if (match[1] !== undefined && match[2]) {
			const src = safeMarkdownUrl(match[2]);
			nodes.push(
				src ? (
					<img
						key={`${keyPrefix}-image-${match.index}`}
						className={cn("message-markdown-image")}
						src={src}
						alt={match[1]}
						loading="lazy"
						draggable={false}
					/>
				) : (
					<Fragment key={`${keyPrefix}-image-raw-${match.index}`}>
						{match[0]}
					</Fragment>
				),
			);
		} else if (match[3] !== undefined && match[4]) {
			const href = safeMarkdownUrl(match[4]);
			nodes.push(
				href ? (
					<a
						key={`${keyPrefix}-link-${match.index}`}
						className={cn("message-markdown-link")}
						href={href}
						target="_blank"
						rel="noreferrer"
					>
						{match[3]}
					</a>
				) : (
					<Fragment key={`${keyPrefix}-link-raw-${match.index}`}>
						{match[0]}
					</Fragment>
				),
			);
		} else if (match[5] !== undefined) {
			nodes.push(
				<code
					key={`${keyPrefix}-code-${match.index}`}
					className={cn("message-markdown-code")}
				>
					{match[5]}
				</code>,
			);
		} else if (match[6] !== undefined) {
			nodes.push(
				<strong key={`${keyPrefix}-strong-${match.index}`}>{match[6]}</strong>,
			);
		} else if (match[7] !== undefined) {
			nodes.push(<del key={`${keyPrefix}-del-${match.index}`}>{match[7]}</del>);
		}

		cursor = match.index + match[0].length;
		match = pattern.exec(value);
	}

	if (cursor < value.length) {
		nodes.push(
			...renderPlainText(value.slice(cursor), `${keyPrefix}-${cursor}`),
		);
	}

	return nodes;
}

function renderPlainText(value: string, keyPrefix: string) {
	return value.split("\n").flatMap((line, index) => {
		const nodes: ReactNode[] = [];
		if (index > 0) {
			nodes.push(<br key={`${keyPrefix}-br-${index}`} />);
		}
		if (line) {
			nodes.push(
				<Fragment key={`${keyPrefix}-text-${index}`}>{line}</Fragment>,
			);
		}
		return nodes;
	});
}

function renderEmojiImage(item: EmojiItem, key: string) {
	return (
		<img
			key={key}
			className={cn(
				item.large ? "message-sticker-image" : "message-emoji-image",
			)}
			src={item.value}
			alt={`[${item.name}]`}
			title={item.name}
			draggable={false}
		/>
	);
}

function safeMarkdownUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: "";
	} catch {
		return "";
	}
}

export function isMarkdownImageOnly(value: string) {
	const trimmed = value.trim();
	return /^!\[[^\]\n]*\]\(https?:\/\/[^\s)]+\)$/i.test(trimmed);
}
