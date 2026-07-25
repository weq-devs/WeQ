// @ts-nocheck
import type { ReactNode } from "react";
import type { Conversation, Message, User } from "./types";

export type MessageRendererContext = {
	message: Message;
	conversation: Conversation;
	sender: User;
	mine: boolean;
};

export type MessageRenderer = {
	id: string;
	match: (context: MessageRendererContext) => boolean;
	render: (context: MessageRendererContext) => ReactNode;
};

export type ComposeMessageRenderersOptions = {
	base?: MessageRenderer[];
	prepend?: MessageRenderer[];
	append?: MessageRenderer[];
};

/**
 * 兜底渲染：把 body 当纯文本画出来。
 *
 * 只有「没被 qqMessageRenderer 认领」的消息会走到这里——unknown-only 但 body 非空、
 * emojiBounce、qqDynamic，以及将来新增的 codec 元素类型。真实的文本/媒体/卡片消息都由
 * qqMessageRenderer 处理。`message-content` 这个 class 必须保留：messageBubble 的
 * selectMessageContent() 靠它做长按选中。
 */
export function renderDefaultMessageContent(message: Message) {
	return (
		<span className="message-content qq-message-inline qq-text-run">
			{message.body}
		</span>
	);
}

export const defaultMessageRenderers: MessageRenderer[] = [
	{
		id: "plain-text",
		match: () => true,
		render: ({ message }) => renderDefaultMessageContent(message),
	},
];

export function composeMessageRenderers({
	base = defaultMessageRenderers,
	prepend = [],
	append = [],
}: ComposeMessageRenderersOptions = {}): MessageRenderer[] {
	return [...prepend, ...base, ...append];
}

export function renderMessageWithRegistry(
	context: MessageRendererContext,
	renderers: MessageRenderer[] = defaultMessageRenderers,
) {
	const renderer = renderers.find((item) => item.match(context));
	return (
		renderer?.render(context) ?? renderDefaultMessageContent(context.message)
	);
}
