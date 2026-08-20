// @ts-nocheck
import { ContactList, ConversationList, GroupList } from './sidebar';
import { ToolsPane } from './toolsPane';
import type { ToolPaneGroup, ToolPaneItem } from './toolRegistry';
import type {
  Contact,
  ContactTab,
  Conversation,
  ConversationDrafts,
  ConversationPreference,
  MainView,
  User,
} from './types';

/**
 * Sidebar content per view.
 *
 * The search box no longer filters these lists — typing in it only drives the
 * unified search dropdown (see SearchDropdown in MainView). The tools pane is
 * the one exception: it keeps its own local keyword filter.
 */
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
  loading,
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
  loading?: boolean;
  onSelectConversation: (conversationId: string, event?: React.MouseEvent) => void;
  onSelectContact: (contact: Contact) => void;
  onSelectGroup: (conversationId: string, event?: React.MouseEvent) => void;
  toolRegistry?: ToolPaneGroup[];
  activateToolsOnSelect?: boolean;
  onSelectTool?: (item: ToolPaneItem) => void;
}) {
  if (view === 'messages') {
    return (
      <ConversationList
        conversations={conversations}
        activeConversationId={activeConversationId}
        preferences={conversationPrefs}
        drafts={drafts}
        user={user}
        loading={loading}
        onSelect={onSelectConversation}
      />
    );
  }

  if (view === 'tools') {
    return (
      <ToolsPane
        query={query}
        registry={toolRegistry}
        activateOnSelect={activateToolsOnSelect}
        onSelectItem={onSelectTool}
      />
    );
  }

  if (view === 'contacts') {
    if (contactTab === 'friends') {
      return (
        <ContactList
          contacts={contacts}
          activeContactId={selectedContactId}
          loading={loading}
          onSelect={onSelectContact}
        />
      );
    }

    return (
      <GroupList
        conversations={conversations}
        activeConversationId={selectedGroupConversationId}
        loading={loading}
        onSelect={onSelectGroup}
      />
    );
  }

  return null;
}
