// @ts-nocheck
import { ContactNoticePane, GroupNoticePane } from "./noticePanes";
import { ContactProfilePane, GroupProfilePane } from "./profilePanes";
import { ChatPane } from "./chatPane";
import { ToolDetailPane } from "./toolsPane";
import type { ComposerActionRegistry } from "./composerActions";
import type { ConversationDetailActionRegistry } from "./conversationDetailActions";
import type { GroupUpdateInput } from "./conversationDetails";
import type { MessageRenderer } from "./messageRenderers";
import type { ProfileActionRegistry } from "./profileActions";
import type { ToolPaneGroup, ToolPaneItem } from "./toolRegistry";
import type {
	Contact,
	ContactNoticeView,
	ContactRequest,
	Conversation,
	ConversationDrafts,
	ConversationPreference,
	GroupJoinRequest,
	MainView,
	Message,
	MessageAction,
	User,
} from "./types";

type GroupConversation = Extract<Conversation, { type: "group" }>;

export function ChatMainContent({
	user,
	view,
	contactNotice,
	contactRequests,
	groupRequests,
	selectedContact,
	selectedGroupConversation,
	activeConversation,
	messages,
	composerActions,
	conversationDetailActions,
	messageRenderers,
	profileActions,
	toolRegistry,
	selectedToolId,
	loadingMessages,
	atLatest,
	conversationPrefs,
	drafts,
	query = "",
	onAcceptContactRequest,
	onRejectContactRequest,
	onAcceptGroupRequest,
	onRejectGroupRequest,
	onMessageContact,
	onMessageGroup,
	onBackContact,
	onBackGroup,
	onBackContactNotice,
	onUpdateConversationPreference,
	onUpdateGroup,
	onLoadMoreGroupMembers,
	groupMembersLoading,
	onOpenNotificationSettings,
	onSend,
	onMessageAction,
	onDraftChange,
	onDraftClear,
	onBackConversation,
	onOpenTool,
	onSelectTool,
}: {
	user: User;
	view: MainView;
	contactNotice: ContactNoticeView | null;
	contactRequests: ContactRequest[];
	groupRequests: GroupJoinRequest[];
	selectedContact?: Contact;
	selectedGroupConversation?: GroupConversation;
	activeConversation?: Conversation;
	messages: Message[];
	composerActions?: Partial<ComposerActionRegistry>;
	conversationDetailActions?: Partial<ConversationDetailActionRegistry>;
	messageRenderers?: MessageRenderer[];
	profileActions?: Partial<ProfileActionRegistry>;
	toolRegistry?: ToolPaneGroup[];
	selectedToolId?: string | null;
	loadingMessages: boolean;
	/** Whether `messages` is the live latest-anchored window (see ChatPane). */
	atLatest?: boolean;
	conversationPrefs: Record<string, ConversationPreference>;
	drafts: ConversationDrafts;
	query?: string;
	onAcceptContactRequest: (requestId: string) => Promise<void>;
	onRejectContactRequest: (requestId: string) => Promise<void>;
	onAcceptGroupRequest: (requestId: string) => Promise<void>;
	onRejectGroupRequest: (requestId: string) => Promise<void>;
	onMessageContact: (contact: Contact) => Promise<void>;
	onMessageGroup: (conversationId: string) => Promise<void>;
	onBackContact: () => void;
	onBackGroup: () => void;
	onBackContactNotice: () => void;
	onUpdateConversationPreference: (
		conversationId: string,
		key: keyof ConversationPreference,
		value: boolean,
	) => void;
	onUpdateGroup: (
		conversationId: string,
		input: GroupUpdateInput,
	) => Promise<void>;
	onLoadMoreGroupMembers?: () => void;
	groupMembersLoading?: boolean;
	onOpenNotificationSettings: () => void;
	onSend: (body: string) => Promise<void>;
	onMessageAction?: (message: Message, action: MessageAction) => Promise<void>;
	onDraftChange: (conversationId: string, value: string) => void;
	onDraftClear: (conversationId: string) => void;
	onBackConversation: () => void;
	onOpenTool?: (item: ToolPaneItem) => void;
	onSelectTool?: (item: ToolPaneItem) => void;
}) {
	if (view === "contacts") {
		if (contactNotice === "friend") {
			return (
				<ContactNoticePane
					requests={contactRequests}
					onAccept={onAcceptContactRequest}
					onReject={onRejectContactRequest}
					onBack={onBackContactNotice}
				/>
			);
		}

		if (contactNotice === "group") {
			return (
				<GroupNoticePane
					requests={groupRequests}
					onAccept={onAcceptGroupRequest}
					onReject={onRejectGroupRequest}
					onBack={onBackContactNotice}
				/>
			);
		}

		if (selectedGroupConversation) {
			return (
				<GroupProfilePane
					conversation={selectedGroupConversation}
					profileActions={profileActions}
					onBack={onBackGroup}
					onMessage={onMessageGroup}
				/>
			);
		}

		return (
			<ContactProfilePane
				contact={selectedContact}
				profileActions={profileActions}
				onBack={onBackContact}
				onMessage={onMessageContact}
			/>
		);
	}

	if (view === "tools") {
		return (
			<ToolDetailPane
				query={query}
				registry={toolRegistry}
				selectedItemId={selectedToolId}
				onOpenItem={onOpenTool}
				onSelectItem={onSelectTool}
			/>
		);
	}

	return (
		<ChatPane
			user={user}
			conversation={activeConversation}
			messages={messages}
			composerActions={composerActions}
			messageRenderers={messageRenderers}
			loading={loadingMessages}
			atLatest={atLatest}
			preference={
				activeConversation
					? conversationPrefs[activeConversation.id]
					: undefined
			}
			draft={activeConversation ? (drafts[activeConversation.id] ?? "") : ""}
			onLoadMoreGroupMembers={onLoadMoreGroupMembers}
			groupMembersLoading={groupMembersLoading}
			onSend={onSend}
			onMessageAction={onMessageAction}
			onDraftChange={onDraftChange}
			onDraftClear={onDraftClear}
			onBack={onBackConversation}
		/>
	);
}
