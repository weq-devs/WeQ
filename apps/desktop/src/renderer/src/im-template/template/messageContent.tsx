// @ts-nocheck
import { CodeBlock } from "./codeBlock";
import { parseMessageParts } from "./emojiPacks";
import {
	isMarkdownImageOnly,
	parseMarkdownBlocks,
	renderInlineMarkdown,
} from "./messageMarkdown";
import type { MarkdownBlock } from "./messageMarkdown";
import { cn } from "./classNames";

export function MessageContent({
	value,
	streamStatus,
}: {
	value: string;
	streamStatus?: "complete" | "streaming" | "failed";
}) {
	const parts = parseMessageParts(value);
	const blocks = parseMarkdownBlocks(value);
	const stickerOnly =
		parts.length === 1 && parts[0].type === "emoji" && parts[0].item.large;
	const markdownImageOnly = isMarkdownImageOnly(value);
	const codeOnly = blocks.length === 1 && blocks[0].type === "code";
	const hasCode = blocks.some((block) => block.type === "code");

	return (
		<div
			className={cn(
				"message-content",
				stickerOnly && "sticker-only",
				markdownImageOnly && "markdown-image-only",
				hasCode && "has-code",
				codeOnly && "code-only",
			)}
		>
			{renderMarkdownBlocks(blocks)}
			{streamStatus === "streaming" ? (
				<span className={cn("message-stream-status")}>正在生成...</span>
			) : null}
			{streamStatus === "failed" ? (
				<span className={cn("message-stream-status failed")}>生成失败</span>
			) : null}
		</div>
	);
}

function renderMarkdownBlocks(blocks: MarkdownBlock[]) {
	return blocks.map((block, index) => {
		const key = `block-${index}`;

		if (block.type === "code") {
			return (
				<CodeBlock key={key} language={block.language} text={block.text} />
			);
		}

		if (block.type === "quote") {
			return (
				<blockquote key={key} className={cn("message-markdown-quote")}>
					{renderInlineMarkdown(block.text, key)}
				</blockquote>
			);
		}

		if (block.type === "list") {
			const ListTag = block.ordered ? "ol" : "ul";
			return (
				<ListTag key={key} className={cn("message-markdown-list")}>
					{block.items.map((item, itemIndex) => (
						<li key={`${key}-item-${itemIndex}`}>
							{renderInlineMarkdown(item, `${key}-item-${itemIndex}`)}
						</li>
					))}
				</ListTag>
			);
		}

		return (
			<p key={key} className={cn("message-markdown-paragraph")}>
				{renderInlineMarkdown(block.text, key)}
			</p>
		);
	});
}
