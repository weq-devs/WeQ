// @ts-nocheck
import type { ReactNode } from "react";
import { MessageContent } from "./messageContent";
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

export function renderDefaultMessageContent(message: Message) {
	return (
		<MessageContent value={message.body} streamStatus={message.streamStatus} />
	);
}

export const defaultMessageRenderers: MessageRenderer[] = [
	{
		id: "markdown",
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
