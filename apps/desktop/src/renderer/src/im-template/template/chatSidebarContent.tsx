// @ts-nocheck
import { ContactList, ConversationList, GroupList } from "./sidebar";
import { ToolsPane } from "./toolsPane";
import type { ToolPaneGroup, ToolPaneItem } from "./toolRegistry";
import type {
	Contact,
	ContactTab,
	Conversation,
	ConversationDrafts,
	ConversationPreference,
	MainView,
	User,
} from "./types";

export function ChatSidebarContent({
	user,
	view,
	contactTab,
	conversations,
	activeConversationId,
	selectedGroupConversationId,
	selectedContactId,
	conversationPrefs,
	drafts,
	contacts,
	query,
	onSelectConversation,
	onSelectContact,
	onSelectGroup,
	toolRegistry,
	activateToolsOnSelect,
	onSelectTool,
}: {
	user?: User;
	view: MainView;
	contactTab: ContactTab;
	conversations: Conversation[];
	activeConversationId: string | null;
	selectedGroupConversationId: string | null;
	selectedContactId: string | null;
	conversationPrefs: Record<string, ConversationPreference>;
	drafts: ConversationDrafts;
	contacts: Contact[];
	query: string;
	onSelectConversation: (conversationId: string) => void;
	onSelectContact: (contact: Contact) => void;
	onSelectGroup: (conversationId: string) => void;
	toolRegistry?: ToolPaneGroup[];
	activateToolsOnSelect?: boolean;
	onSelectTool?: (item: ToolPaneItem) => void;
}) {
	if (view === "messages") {
		return (
			<ConversationList
				conversations={conversations}
				activeConversationId={activeConversationId}
				preferences={conversationPrefs}
				drafts={drafts}
				query={query}
				user={user}
				onSelect={onSelectConversation}
			/>
		);
	}

	if (view === "tools") {
		return (
			<ToolsPane
				query={query}
				registry={toolRegistry}
				activateOnSelect={activateToolsOnSelect}
				onSelectItem={onSelectTool}
			/>
		);
	}

	if (view === "contacts" && contactTab === "friends") {
		return (
			<ContactList
				contacts={contacts}
				activeContactId={selectedContactId}
				query={query}
				onSelect={onSelectContact}
			/>
		);
	}

	if (view === "contacts") {
		return (
			<GroupList
				conversations={conversations}
				activeConversationId={selectedGroupConversationId}
				query={query}
				onSelect={onSelectGroup}
			/>
		);
	}

	return null;
}
