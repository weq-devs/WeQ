// @ts-nocheck
import type { RefObject } from "react";
import {
	resolveConversationDetailActionRegistry,
	type ConversationDetailActionContext,
	type ConversationDetailActionRegistry,
} from "./conversationDetailActions";
import { DesktopDetailActionGroups } from "./conversationDetailActionRows";
import { GroupSettingsPanel } from "./groupSettingsPanel";
import { Avatar } from "./primitives";
import type { Conversation, ConversationPreference } from "./types";
import type { GroupUpdateInput } from "./conversationDetailsTypes";
import { displayUserName } from "./user";
import { cn } from "./classNames";

export { GroupInfoPanel } from "./groupInfoPanel";
export { GroupInviteDialog } from "./groupInviteDialog";
export type {
	GroupConversationView,
	GroupUpdateInput,
} from "./conversationDetailsTypes";

export function ConversationDetailsPanel({
	conversation,
	preference,
	panelRef,
	onPreferenceChange,
	onUpdateGroup,
	onClearMessages,
	onOpenNotificationSettings,
	conversationDetailActions,
}: {
	conversation: Conversation;
	preference: ConversationPreference;
	panelRef: RefObject<HTMLElement | null>;
	onPreferenceChange: (
		conversationId: string,
		key: keyof ConversationPreference,
		value: boolean,
	) => void;
	onUpdateGroup: (
		conversationId: string,
		input: GroupUpdateInput,
	) => Promise<void>;
	onClearMessages: () => void;
	onOpenNotificationSettings: () => void;
	conversationDetailActions?: Partial<ConversationDetailActionRegistry>;
}) {
	function toggle(key: keyof ConversationPreference) {
		onPreferenceChange(conversation.id, key, !preference[key]);
	}
	const actionRegistry = resolveConversationDetailActionRegistry(
		conversationDetailActions,
	);
	const actionContext: ConversationDetailActionContext = {
		conversation,
		preference,
		togglePreference: toggle,
		clearLocalMessages: onClearMessages,
		openNotificationSettings: onOpenNotificationSettings,
	};

	if (conversation.type === "group") {
		return (
			<GroupSettingsPanel
				conversation={conversation}
				panelRef={panelRef}
				onUpdateGroup={onUpdateGroup}
				detailActionGroups={actionRegistry.groupDesktop}
				detailActionContext={actionContext}
			/>
		);
	}

	return (
		<aside
			className={cn("conversation-details")}
			ref={panelRef}
			aria-label="会话设置"
		>
			<div className={cn("conversation-details-profile")}>
				<Avatar
					name={displayUserName(conversation.otherUser)}
					avatarUrl={conversation.otherUser.avatarUrl}
					seed={conversation.otherUser.identityValue}
				/>
				<strong>{displayUserName(conversation.otherUser)}</strong>
				<span className={cn("copyable-text")}>
					{conversation.otherUser.identityLabel}{" "}
					{conversation.otherUser.identityValue}
				</span>
			</div>

			<DesktopDetailActionGroups
				groups={actionRegistry.directDesktop}
				context={actionContext}
			/>
		</aside>
	);
}
