import {
  ContactProfileDialog,
  ContactProfilePane,
  GroupProfileDialog,
  GroupProfilePane,
} from './profilePanes';
import { ChatPane, type ChatPaneProps } from './chatPane';
import { ToolDetailPane } from './toolsPane';
import { RetainedTabs, TabActivity } from '../../components/RetainedTabs';
import type { ProfileActionRegistry } from './profileActions';
import type { ContactWorkspaceTab, GroupWorkspaceTab } from '../../lib/profileNavigation';
import type { ToolPaneGroup, ToolPaneItem } from './toolRegistry';
import type {
  Contact,
  ContactTab,
  Conversation,
  ConversationDrafts,
  ConversationPreference,
  MainView,
} from './types';

type GroupConversation = Extract<Conversation, { type: 'group' }>;

export function ChatMainContent({
  user,
  view,
  contactTab,
  relationGraphSlot,
  contactOverviewOpen = true,
  selectedContact,
  onPreviewContactChat,
  contactPreviewContent,
  contactWorkspaceTab,
  onContactWorkspaceTabChange,
  selectedGroupConversation,
  contactGroupDetails,
  groupWorkspaceLocation,
  activeConversation,
  messages,
  composerActions,
  messageRenderers,
  profileActions: _profileActions,
  toolRegistry,
  selectedToolId,
  loadingMessages,
  loadingNewer,
  initialReadingPosition,
  atLatest,
  latestMessageSeq,
  onPreviewLatest,
  onJumpToLatest,
  onReadCurrentConversation,
  conversationPrefs,
  drafts,
  query = '',
  onBackContact,
  onBackGroup,
  onLoadMoreGroupMembers,
  groupMembersLoading,
  groupMembersError,
  groupMemberSearch,
  onGroupMemberSearchChange,
  onLoadMoreGroupMemberSearch,
  profileLoading,
  sendAvailable,
  onSend,
  onRepeatMessage,
  onResolveMentions,
  onSearchMentionMembers,
  onStartCall,
  onSendArk,
  arkLocation,
  arkContacts,
  defaultSignupGroupCode,
  onSendFlash,
  onSendFlashPhoto,
  onSendBubbleVideo,
  onSendRedPacket,
  onMessageAction,
  onDraftChange,
  onDraftClear,
  onBackConversation,
  onEditRaw,
  onDeleteMessage,
  onDismissUnsentMessage,
  onStartOutgoingMessage,
  onOpenGroupAlbums,
  onOpenGroupFiles,
  onOpenGroupAnnouncements,
  groupTodos,
  groupSidebarFeature,
  onOpenGroupSign,
  onOpenGroupEssence,
  onOpenGroupInfoDetail,
  onRenameGroupMember,
  onChangeGroupMemberTitle,
  onKickGroupMember,
  onOpenConversationSettings,
  onOpenGroupBug,
  onOpenGroupLeftMembers,
  groupBugOnline,
  onOpenGroupMember,
  onAddMessage,
  onMergeForward,
  onAddToComposition,
  onForwardMessages,
  onViewDeleted,
  onViewRecalled,
  onOpenGapMessages,
  onLoadSelectionMessages,
  onSearchChatRecords,
  onOpenRoamingBackfill,
  deletedIds,
  hiddenDeletedIds,
  onRestoreMessage,
  onOpenTool,
  onSelectTool,
  unreadDock,
  missingJumpSeq,
  resolvedGapIds,
  onLoadOlder,
  onLoadNewer,
  hasOlder,
  onTimelineElement,
}: Pick<
  ChatPaneProps,
  | 'user'
  | 'messages'
  | 'composerActions'
  | 'messageRenderers'
  | 'loadingNewer'
  | 'initialReadingPosition'
  | 'atLatest'
  | 'latestMessageSeq'
  | 'onPreviewLatest'
  | 'onJumpToLatest'
  | 'onReadCurrentConversation'
  | 'onLoadMoreGroupMembers'
  | 'groupMembersLoading'
  | 'groupMembersError'
  | 'groupMemberSearch'
  | 'onGroupMemberSearchChange'
  | 'onLoadMoreGroupMemberSearch'
  | 'profileLoading'
  | 'sendAvailable'
  | 'onSend'
  | 'onRepeatMessage'
  | 'onResolveMentions'
  | 'onSearchMentionMembers'
  | 'onStartCall'
  | 'onSendArk'
  | 'arkLocation'
  | 'arkContacts'
  | 'defaultSignupGroupCode'
  | 'onSendFlash'
  | 'onSendFlashPhoto'
  | 'onSendBubbleVideo'
  | 'onSendRedPacket'
  | 'onMessageAction'
  | 'onDraftChange'
  | 'onDraftClear'
  | 'onEditRaw'
  | 'onDeleteMessage'
  | 'onDismissUnsentMessage'
  | 'onStartOutgoingMessage'
  | 'onOpenGroupAlbums'
  | 'onOpenGroupFiles'
  | 'onOpenGroupAnnouncements'
  | 'groupTodos'
  | 'groupSidebarFeature'
  | 'onOpenGroupSign'
  | 'onOpenGroupEssence'
  | 'onOpenGroupInfoDetail'
  | 'onRenameGroupMember'
  | 'onChangeGroupMemberTitle'
  | 'onKickGroupMember'
  | 'onOpenConversationSettings'
  | 'onOpenGroupBug'
  | 'onOpenGroupLeftMembers'
  | 'groupBugOnline'
  | 'onOpenGroupMember'
  | 'onAddMessage'
  | 'onViewDeleted'
  | 'onViewRecalled'
  | 'onOpenGapMessages'
  | 'onLoadSelectionMessages'
  | 'onSearchChatRecords'
  | 'onOpenRoamingBackfill'
  | 'deletedIds'
  | 'hiddenDeletedIds'
  | 'onRestoreMessage'
  | 'onMergeForward'
  | 'onAddToComposition'
  | 'onForwardMessages'
  | 'unreadDock'
  | 'missingJumpSeq'
  | 'resolvedGapIds'
  | 'onLoadOlder'
  | 'onLoadNewer'
  | 'hasOlder'
  | 'onTimelineElement'
> & {
  view: MainView;
  contactTab?: ContactTab;
  relationGraphSlot?: React.ReactNode;
  contactOverviewOpen?: boolean;
  selectedContact?: Contact;
  onPreviewContactChat?: (contact: Contact) => void;
  contactPreviewContent?: React.ReactNode;
  contactWorkspaceTab?: ContactWorkspaceTab;
  groupWorkspaceLocation?: {
    code: string;
    section?: GroupWorkspaceTab;
    albumId?: string;
    folderId?: string;
    fileId?: string;
  };
  onContactWorkspaceTabChange?: (tab: ContactWorkspaceTab) => void;
  selectedGroupConversation?: GroupConversation;
  contactGroupDetails?: React.ReactNode;
  activeConversation?: Conversation;
  profileActions?: Partial<ProfileActionRegistry>;
  toolRegistry?: ToolPaneGroup[];
  selectedToolId?: string | null;
  loadingMessages: boolean;
  conversationPrefs: Record<string, ConversationPreference>;
  drafts: ConversationDrafts;
  query?: string;
  onBackContact: () => void;
  onBackGroup: () => void;
  onBackConversation: () => void;
  onOpenTool?: (item: ToolPaneItem) => void;
  onSelectTool?: (item: ToolPaneItem) => void;
}) {
  if (view === 'contacts') {
    return (
      <>
        <div
          className="weq-contact-overview"
          hidden={Boolean(selectedContact || selectedGroupConversation)}
        >
          <TabActivity active={!selectedContact && !selectedGroupConversation}>
            <RetainedTabs
              snapshotKey="contact-overview"
              activeKey={contactOverviewOpen ? 'graph' : 'empty'}
            >
              {contactOverviewOpen && relationGraphSlot ? (
                relationGraphSlot
              ) : contactTab === 'groups' ? (
                <GroupProfilePane onOpenOverview={onBackGroup} />
              ) : (
                <ContactProfilePane onOpenOverview={onBackContact} />
              )}
            </RetainedTabs>
          </TabActivity>
        </div>
        {selectedContact ? (
          <ContactProfileDialog
            embedded
            contact={selectedContact}
            onClose={onBackContact}
            tab={contactWorkspaceTab}
            onTabChange={onContactWorkspaceTabChange}
            onPreviewChat={onPreviewContactChat}
            previewContent={contactPreviewContent}
          />
        ) : selectedGroupConversation ? (
          <GroupProfileDialog
            embedded
            {...(groupWorkspaceLocation?.code === selectedGroupConversation.id
              ? groupWorkspaceLocation
              : {})}
            details={contactGroupDetails}
            conversation={selectedGroupConversation}
            onClose={onBackGroup}
          />
        ) : null}
      </>
    );
  }

  if (view === 'tools') {
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
      loadingNewer={loadingNewer}
      initialReadingPosition={initialReadingPosition}
      atLatest={atLatest}
      latestMessageSeq={latestMessageSeq}
      onPreviewLatest={onPreviewLatest}
      onJumpToLatest={onJumpToLatest}
      onReadCurrentConversation={onReadCurrentConversation}
      preference={activeConversation ? conversationPrefs[activeConversation.id] : undefined}
      draft={activeConversation ? (drafts[activeConversation.id] ?? '') : ''}
      onLoadMoreGroupMembers={onLoadMoreGroupMembers}
      groupMembersLoading={groupMembersLoading}
      groupMembersError={groupMembersError}
      groupMemberSearch={groupMemberSearch}
      onGroupMemberSearchChange={onGroupMemberSearchChange}
      onLoadMoreGroupMemberSearch={onLoadMoreGroupMemberSearch}
      profileLoading={profileLoading}
      sendAvailable={sendAvailable}
      onSend={onSend}
      onRepeatMessage={onRepeatMessage}
      onResolveMentions={onResolveMentions}
      onSearchMentionMembers={onSearchMentionMembers}
      onStartCall={onStartCall}
      onSendArk={onSendArk}
      arkLocation={arkLocation}
      arkContacts={arkContacts}
      defaultSignupGroupCode={defaultSignupGroupCode}
      onSendFlash={onSendFlash}
      onSendFlashPhoto={onSendFlashPhoto}
      onSendBubbleVideo={onSendBubbleVideo}
      onSendRedPacket={onSendRedPacket}
      onMessageAction={onMessageAction}
      onDraftChange={onDraftChange}
      onDraftClear={onDraftClear}
      onBack={onBackConversation}
      onEditRaw={onEditRaw}
      onDeleteMessage={onDeleteMessage}
      onDismissUnsentMessage={onDismissUnsentMessage}
      onStartOutgoingMessage={onStartOutgoingMessage}
      onOpenGroupAlbums={onOpenGroupAlbums}
      onOpenGroupFiles={onOpenGroupFiles}
      onOpenGroupAnnouncements={onOpenGroupAnnouncements}
      groupTodos={groupTodos}
      groupSidebarFeature={groupSidebarFeature}
      onOpenGroupSign={onOpenGroupSign}
      onOpenGroupEssence={onOpenGroupEssence}
      onOpenGroupInfoDetail={onOpenGroupInfoDetail}
      onRenameGroupMember={onRenameGroupMember}
      onChangeGroupMemberTitle={onChangeGroupMemberTitle}
      onKickGroupMember={onKickGroupMember}
      onOpenConversationSettings={onOpenConversationSettings}
      onOpenGroupBug={onOpenGroupBug}
      onOpenGroupLeftMembers={onOpenGroupLeftMembers}
      groupBugOnline={groupBugOnline}
      onOpenGroupMember={onOpenGroupMember}
      onAddMessage={onAddMessage}
      onMergeForward={onMergeForward}
      onAddToComposition={onAddToComposition}
      onForwardMessages={onForwardMessages}
      onViewDeleted={onViewDeleted}
      onViewRecalled={onViewRecalled}
      onOpenGapMessages={onOpenGapMessages}
      onLoadSelectionMessages={onLoadSelectionMessages}
      onSearchChatRecords={onSearchChatRecords}
      onOpenRoamingBackfill={onOpenRoamingBackfill}
      deletedIds={deletedIds}
      hiddenDeletedIds={hiddenDeletedIds}
      onRestoreMessage={onRestoreMessage}
      unreadDock={unreadDock}
      missingJumpSeq={missingJumpSeq}
      resolvedGapIds={resolvedGapIds}
      onLoadOlder={onLoadOlder}
      onLoadNewer={onLoadNewer}
      hasOlder={hasOlder}
      onTimelineElement={onTimelineElement}
    />
  );
}
