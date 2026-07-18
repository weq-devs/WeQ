// @ts-nocheck
import { ContactNoticeDialog, GroupNoticeDialog } from "./noticePanes";
import { ContactProfileDialog, ContactProfilePane, GroupProfileDialog, GroupProfilePane } from "./profilePanes";
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
	ContactTab,
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
type DirectConversation = Extract<Conversation, { type: "direct" }>;

export function ChatMainContent({
	user,
	view,
	contactTab,
	relationGraphSlot,
	chatHomeSlot,
	contactNotice,
	contactRequests,
	groupRequests,
	selectedContact,
	selectedGroupConversation,
	activeConversation,
	messages,
	composerActions,
	conversationDetailActions: _conversationDetailActions,
	messageRenderers,
	profileActions: _profileActions,
	toolRegistry,
	selectedToolId,
	loadingMessages,
	atLatest,
	conversationPrefs,
	drafts,
	query = "",
	onAcceptContactRequest: _onAcceptContactRequest,
	onRejectContactRequest: _onRejectContactRequest,
	onAcceptGroupRequest: _onAcceptGroupRequest,
	onRejectGroupRequest: _onRejectGroupRequest,
	onMessageContact: _onMessageContact,
	onMessageGroup: _onMessageGroup,
	onBackContact,
	onBackGroup,
	onBackContactNotice,
	onUpdateConversationPreference: _onUpdateConversationPreference,
	onUpdateGroup: _onUpdateGroup,
	onLoadMoreGroupMembers,
	groupMembersLoading,
	onOpenNotificationSettings: _onOpenNotificationSettings,
	onSend,
	onMessageAction,
	onDraftChange,
	onDraftClear,
	onBackConversation,
	onEditRaw,
	onDeleteMessage,
	onOpenGroupAlbums,
	onOpenGroupAnnouncements,
	onOpenGroupAnalytics,
	onOpenBuddyAnalytics,
	onOpenGroupMember,
	onAddMessage,
	onViewDeleted,
	onViewRecalled,
	deletedIds,
	onRestoreMessage,
	onOpenTool,
	onSelectTool,
}: {
	user: User;
	view: MainView;
	contactTab?: ContactTab;
	/** App-provided content for the contacts main area (the relation graph). */
	relationGraphSlot?: React.ReactNode;
	/**
	 * App-provided landing shown in the messages view when no conversation is
	 * selected (the animated home facade). Falls back to ChatPane's built-in
	 * empty state when omitted.
	 */
	chatHomeSlot?: React.ReactNode;
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
	onEditRaw?: (message: Message) => void;
	onDeleteMessage?: (message: Message, conversation: Conversation) => void | Promise<void>;
	onOpenGroupAlbums?: (conversation: GroupConversation) => void;
	onOpenGroupAnnouncements?: (conversation: GroupConversation) => void;
	onOpenGroupAnalytics?: (conversation: GroupConversation) => void;
	onOpenBuddyAnalytics?: (conversation: DirectConversation) => void;
	onOpenGroupMember?: (member: any, anchor: { x: number; y: number }) => void;
	onAddMessage?: (conversation: Conversation) => void;
	onViewDeleted?: (conversation: Conversation) => void;
	onViewRecalled?: (conversation: Conversation) => void;
	/** msgIds WeQ deleted in the active conversation (in-place overlay). */
	deletedIds?: Set<string>;
	/** Restore one WeQ-deleted message (overlay hover button). */
	onRestoreMessage?: (msgId: string) => Promise<void>;
	onOpenTool?: (item: ToolPaneItem) => void;
	onSelectTool?: (item: ToolPaneItem) => void;
}) {
	if (view === "contacts") {
		return (
			<>
				{relationGraphSlot ??
					(contactTab === "groups" ? <GroupProfilePane /> : <ContactProfilePane />)}
				<ContactProfileDialog
					contact={selectedContact}
					onClose={onBackContact}
				/>
				<GroupProfileDialog
					conversation={selectedGroupConversation}
					onClose={onBackGroup}
				/>
				<ContactNoticeDialog
					open={contactNotice === "friend"}
					requests={contactRequests}
					onClose={onBackContactNotice}
				/>
				<GroupNoticeDialog
					open={contactNotice === "group"}
					requests={groupRequests}
					onClose={onBackContactNotice}
				/>
			</>
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

	if (!activeConversation && chatHomeSlot) {
		return <>{chatHomeSlot}</>;
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
			onEditRaw={onEditRaw}
			onDeleteMessage={onDeleteMessage}
			onOpenGroupAlbums={onOpenGroupAlbums}
			onOpenGroupAnnouncements={onOpenGroupAnnouncements}
			onOpenGroupAnalytics={onOpenGroupAnalytics}
			onOpenBuddyAnalytics={onOpenBuddyAnalytics}
			onOpenGroupMember={onOpenGroupMember}
			onAddMessage={onAddMessage}
			onViewDeleted={onViewDeleted}
			onViewRecalled={onViewRecalled}
			deletedIds={deletedIds}
			onRestoreMessage={onRestoreMessage}
		/>
	);
}
