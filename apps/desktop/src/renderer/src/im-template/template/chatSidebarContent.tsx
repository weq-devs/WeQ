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

	if (view === "contacts") {
		// When searching, show both friends and groups with section headers
		if (query.trim()) {
			const lowerQuery = query.toLowerCase();
			const matchedContacts = contacts.filter(c =>
				c.displayName?.toLowerCase().includes(lowerQuery) ||
				c.username?.toLowerCase().includes(lowerQuery)
			);
			const matchedGroups = conversations.filter(conv =>
				conv.type === 'group' && (
					conv.name?.toLowerCase().includes(lowerQuery) ||
					conv.group?.name?.toLowerCase().includes(lowerQuery)
				)
			);

			return (
				<div className="contact-search-results">
					{matchedContacts.length > 0 && (
						<>
							<div className="search-section-header">好友</div>
							<ContactList
								contacts={contacts}
								activeContactId={selectedContactId}
								query={query}
								onSelect={onSelectContact}
							/>
						</>
					)}
					{matchedGroups.length > 0 && (
						<>
							<div className="search-section-header">群聊</div>
							<GroupList
								conversations={conversations}
								activeConversationId={selectedGroupConversationId}
								query={query}
								onSelect={onSelectGroup}
							/>
						</>
					)}
					{matchedContacts.length === 0 && matchedGroups.length === 0 && (
						<div className="search-empty">未找到匹配的联系人或群聊</div>
					)}
				</div>
			);
		}

		// No search query, show based on tab
		if (contactTab === "friends") {
			return (
				<ContactList
					contacts={contacts}
					activeContactId={selectedContactId}
					query={query}
					onSelect={onSelectContact}
				/>
			);
		}

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
