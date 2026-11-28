import { ContactProfileDialog, GroupProfileDialog } from '../../components/lazyMainPanels';
import { ContactProfilePane, GroupProfilePane } from '../../components/ProfileEmptyPanes';
import { ChatPane, type ChatPaneProps } from './chatPane';
import { ToolDetailPane } from './toolsPane';
import { RetainedTabs, TabActivity } from '../../components/RetainedTabs';
import { ArrowLeft } from 'lucide-react';
import { APP_NAVIGATION } from '../../lib/appNavigation';
import { preferenceValue, useClientPreferences } from '../../lib/clientPreferences';
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
  contactOverviewOpen = false,
  onBackContactOverview,
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
  peerTyping,
  composerActions,
  messageRenderers,
  profileActions: _profileActions,
  toolRegistry,
  selectedToolId,
  loadingMessages,
  loadError,
  pagingLoadError,
  loadingNewer,
  locatingMessage,
  initialReadingPosition,
  atLatest,
  latestMessageSeq,
  onPreviewLatest,
  onJumpToLatest,
  onJumpToReadingPosition,
  onDismissReadingJump,
  chatJumpLayout,
  readThroughViewport,
  confirmedReadSeq,
  onReadCurrentConversation,
  onSeeReplies,
  pendingInteractions,
  onSeeInteractions,
  conversationPrefs,
  drafts,
  draftScope,
  query = '',
  onBackContact,
  onBackGroup,
  onLoadMoreGroupMembers,
  onGroupMemberDemand,
  groupMembersLoading,
  groupMembersError,
  groupMemberSearch,
  onGroupMemberSearchChange,
  mapGroupRosterMember,
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
  onSentSpeechDraft,
  onBackConversation,
  onMessageRecordEdited,
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
  messageRecords,
  onCloseMessageRecords,
  onOpenGapMessages,
  onLoadSelectionMessages,
  onSearchChatRecords,
  searchQuote,
  onSearchQuoteHandled,
  onOpenRoamingBackfill,
  deletedIds,
  hiddenDeletedIds,
  onRestoreMessage,
  onOpenTool,
  onSelectTool,
  unreadDock,
  unreadDividerRange,
  unreadDockEntryPending,
  unreadDockViewportActive,
  onConsumeUnreadDock,
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
  | 'peerTyping'
  | 'composerActions'
  | 'messageRenderers'
  | 'loadError'
  | 'pagingLoadError'
  | 'loadingNewer'
  | 'locatingMessage'
  | 'initialReadingPosition'
  | 'atLatest'
  | 'latestMessageSeq'
  | 'onPreviewLatest'
  | 'onJumpToLatest'
  | 'onJumpToReadingPosition'
  | 'onDismissReadingJump'
  | 'chatJumpLayout'
  | 'onReadCurrentConversation'
  | 'onSeeReplies'
  | 'readThroughViewport'
  | 'confirmedReadSeq'
  | 'pendingInteractions'
  | 'onSeeInteractions'
  | 'onLoadMoreGroupMembers'
  | 'onGroupMemberDemand'
  | 'groupMembersLoading'
  | 'groupMembersError'
  | 'groupMemberSearch'
  | 'onGroupMemberSearchChange'
  | 'mapGroupRosterMember'
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
  | 'draftScope'
  | 'onDraftChange'
  | 'onDraftClear'
  | 'onSentSpeechDraft'
  | 'onMessageRecordEdited'
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
  | 'messageRecords'
  | 'onCloseMessageRecords'
  | 'onOpenGapMessages'
  | 'onLoadSelectionMessages'
  | 'onSearchChatRecords'
  | 'searchQuote'
  | 'onSearchQuoteHandled'
  | 'onOpenRoamingBackfill'
  | 'deletedIds'
  | 'hiddenDeletedIds'
  | 'onRestoreMessage'
  | 'onMergeForward'
  | 'onAddToComposition'
  | 'onForwardMessages'
  | 'unreadDock'
  | 'unreadDividerRange'
  | 'unreadDockEntryPending'
  | 'unreadDockViewportActive'
  | 'onConsumeUnreadDock'
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
  onBackContactOverview?: () => void;
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
  const groupMessages = useClientPreferences(() => preferenceValue('groupConsecutiveMessages'));
  if (view === 'contacts') {
    return (
      <>
        <div
          className="weq-contact-overview"
          hidden={Boolean(selectedContact || selectedGroupConversation)}
        >
          {contactOverviewOpen && onBackContactOverview ? (
            <header className="weq-contact-overview-toolbar">
              <button
                type="button"
                aria-label="返回联系人列表"
                title="返回联系人列表"
                onClick={onBackContactOverview}
              >
                <ArrowLeft size={20} aria-hidden />
              </button>
              <strong>{APP_NAVIGATION['group-intersection'].label}</strong>
            </header>
          ) : null}
          <TabActivity active={!selectedContact && !selectedGroupConversation}>
            <RetainedTabs
              snapshotKey="contact-overview"
              activeKey={contactOverviewOpen ? 'graph' : 'empty'}
            >
              {contactOverviewOpen && relationGraphSlot ? (
                relationGraphSlot
              ) : contactTab === 'groups' ? (
                <GroupProfilePane />
              ) : (
                <ContactProfilePane />
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
      peerTyping={peerTyping}
      user={user}
      conversation={activeConversation}
      messages={messages}
      groupConsecutiveMessages={
        groupMessages &&
        (activeConversation?.type === 'direct' || activeConversation?.type === 'group')
      }
      composerActions={composerActions}
      messageRenderers={messageRenderers}
      loading={loadingMessages}
      loadError={loadError}
      pagingLoadError={pagingLoadError}
      loadingNewer={loadingNewer}
      locatingMessage={locatingMessage}
      initialReadingPosition={initialReadingPosition}
      atLatest={atLatest}
      latestMessageSeq={latestMessageSeq}
      onPreviewLatest={onPreviewLatest}
      onJumpToLatest={onJumpToLatest}
      onJumpToReadingPosition={onJumpToReadingPosition}
      onDismissReadingJump={onDismissReadingJump}
      chatJumpLayout={chatJumpLayout}
      readThroughViewport={readThroughViewport}
      confirmedReadSeq={confirmedReadSeq}
      onReadCurrentConversation={onReadCurrentConversation}
      onSeeReplies={onSeeReplies}
      pendingInteractions={pendingInteractions}
      onSeeInteractions={onSeeInteractions}
      preference={activeConversation ? conversationPrefs[activeConversation.id] : undefined}
      draft={activeConversation ? (drafts[activeConversation.id] ?? '') : ''}
      draftScope={draftScope}
      onLoadMoreGroupMembers={onLoadMoreGroupMembers}
      onGroupMemberDemand={onGroupMemberDemand}
      groupMembersLoading={groupMembersLoading}
      groupMembersError={groupMembersError}
      groupMemberSearch={groupMemberSearch}
      onGroupMemberSearchChange={onGroupMemberSearchChange}
      mapGroupRosterMember={mapGroupRosterMember}
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
      onSentSpeechDraft={onSentSpeechDraft}
      onBack={onBackConversation}
      onMessageRecordEdited={onMessageRecordEdited}
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
      messageRecords={messageRecords}
      onCloseMessageRecords={onCloseMessageRecords}
      onOpenGapMessages={onOpenGapMessages}
      onLoadSelectionMessages={onLoadSelectionMessages}
      onSearchChatRecords={onSearchChatRecords}
      searchQuote={searchQuote}
      onSearchQuoteHandled={onSearchQuoteHandled}
      onOpenRoamingBackfill={onOpenRoamingBackfill}
      deletedIds={deletedIds}
      hiddenDeletedIds={hiddenDeletedIds}
      onRestoreMessage={onRestoreMessage}
      unreadDock={unreadDock}
      unreadDividerRange={unreadDividerRange}
      unreadDockEntryPending={unreadDockEntryPending}
      unreadDockViewportActive={unreadDockViewportActive}
      onConsumeUnreadDock={onConsumeUnreadDock}
      missingJumpSeq={missingJumpSeq}
      resolvedGapIds={resolvedGapIds}
      onLoadOlder={onLoadOlder}
      onLoadNewer={onLoadNewer}
      hasOlder={hasOlder}
      onTimelineElement={onTimelineElement}
    />
  );
}
