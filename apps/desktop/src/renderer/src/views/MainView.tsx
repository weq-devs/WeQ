/**
 * 主聊天工作区：连接页面外壳、业务动作与工具视图。
 * 消息窗口、草稿、目录及 DTO 投影分别由 workspace/ 下的模块维护。
 */
import { useMessageWindowState } from './workspace/useMessageWindowState';
import {
  useConversationWindowSelection,
  useMessageReadSelection,
  useMessageWindowDescriptor,
  useConversationWindowEntry,
  readUnreadInfos,
} from './workspace/useConversationWindowRead';
import { PAGE_SIZE } from './workspace/paging';
import {
  countMessageBadgeUnread,
  createUnreadConversationCycle,
  firstUnreadMessage,
  matchesUnreadMessage,
} from '../lib/unreadNavigation';
import {
  toMessageWire,
  optimisticToTemplate,
  optimisticArkToTemplate,
  optimisticMessageToTemplate,
  messageToTemplate,
  resolveRecallRevokerName,
  enrichReplyElements,
  messageBody,
  isRenderableMessage,
  nearestBySeq,
  findTimelineMessageById,
  extractGrayTipUids,
} from './workspace/messageProjection';
import {
  fallbackPreference,
  groupAvatarSrc,
  senderAvatarSrc,
  secondsToIsoTime,
  chatTypeKind,
  currentUser,
  buddyToContact,
  groupMemberWireToMember,
} from './workspace/identity';
import type {
  RecentContactWire,
  HiddenSessionWire,
  DeletedSessionWire,
  MessageWire,
  ChatMsgWire,
  UserProfileWire,
  GroupMemberWire,
  BuddyWire,
  CategoryWire,
  BuddyRequestWire,
  GroupNotifyWire,
  GroupDetailWire,
  GroupEssenceWire,
  RawElementWire,
  OptimisticForward,
  OptimisticArk,
  OptimisticMessage,
} from './workspace/types';
import { useWorkspaceDrafts } from './workspace/useWorkspaceDrafts';
import { useWorkspaceDirectory } from './workspace/useWorkspaceDirectory';
import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { z } from 'zod';
import { OverlayScrollbar } from '../components/OverlayScrollbar';
import { trpc } from '../trpc/client';
import { IS_WEB } from '../lib/target.shared';
import { isSingleColumnLayout } from '../lib/responsiveLayout';
import {
  type InfiniteData,
  replaceEqualDeep,
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { WebBusinessCache } from '../components/WebBusinessCache';
import {
  RECENT_HEAD_SIZE,
  recentContactHeadOptions,
  useRecentContactQueries,
} from '../hooks/useRecentContactQueries';
import { resolvedProfilesKey } from '../lib/webBusinessCache';
import { scheduleBackgroundLoad } from '../lib/backgroundLoad';
import {
  selectProfileContacts,
  conversationProfileTargets,
} from '../lib/visibleConversationProfiles';
import {
  nextStartupQueryStage,
  scheduleStartupQueryBatch,
  type StartupQueryStage,
} from '../lib/startupQueries';
import { useContactOnlineStatuses } from '../hooks/useContactOnlineStatuses';
import { useContactNoticeUpdates } from '../hooks/useContactNoticeUpdates';
import { CONTACT_NOTICE_LIMIT } from '../../../shared/contact_notices';
import { useEventContextValue } from '../hooks/useEventContextValue';
import { useStableCallback } from '../hooks/useStableCallback';
import { useMobilePageSettled } from '../hooks/useMobilePageSettled';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { useMobileBack } from '../hooks/useMobileNavigation';
import { MobileSidebarPages } from '../components/MobileSidebarPages';
import { withBrowserFile } from '../lib/browserFileUpload';
import { stageAccountFile } from '../lib/accountFilePicker';
import { WEB_NOTICE_OPEN } from '../lib/browserNotifications';
import type { WebNotice } from '../../../main/web/notices';
import type { ChatMsgWire as IncomingMessageWire } from '../../../main/ipc/serde';
import { createReplyPreviewIndex } from '../lib/replyPreview';
import { revealTimelineMessage } from '../lib/timelineViewport';
import { recordMessagePhase } from '../lib/messagePerformance';
import { specialCareBlocker } from '../lib/specialCareAccess';
import {
  loadGroupAssistantPins,
  saveGroupAssistantPins,
  isAssistantPinned,
  groupAssistantPreferences,
} from '../lib/groupAssistant';
import {
  mergeRoamingTimeline,
  mergeRoamingWindow,
  timelineRowKey,
} from '../../../shared/roaming_timeline';
import { useViewState } from '../state/view';
import { resolveDraftSave } from '../lib/draftPersistence';
import {
  currentAccountScope,
  patchAccountRecords,
  useAccountRecords,
  useClientPreferences,
  preferenceValue,
  accountBinding as sharedAccountBinding,
} from '../lib/clientPreferences';
import { useWebConnection } from '../state/webConnection';
import { useEnhancementUpdates } from '../hooks/useEnhancementUpdates';
import { client } from '../trpc/client';
import { useToast, sourceToastPush } from '../components/Toast.shared';
import {
  notificationContent,
  notificationSource,
  restoreNotificationSource,
  onNotificationNavigation,
  conversationNotificationSource,
  messageNotificationSource,
} from '../lib/notificationNavigation.shared';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { useOpenAnnouncement } from '../lib/announcementPresentation';
import { useMessageLocateFeedback } from '../hooks/useMessageLocateFeedback';
import { onOpenSettingsRequest } from '../lib/callSettingsBridge';
import { useUnreadMarkers } from '../lib/unreadMarkers';
import { TabActivity } from '../components/RetainedTabs';
import {
  OPEN_NOTIFICATION_SETTINGS,
  type NotificationSettingsRequest,
} from '../lib/notificationSettingsNavigation';
import { useDialog } from '../components/Dialog.shared';
import { generatedConversationDeletion } from '../lib/generatedConversationDeletion';
import { ForwardWindowHost } from '../components/ForwardWindow';
import { closeForwardWindows } from '../state/forwardWindow';
import { Undo2 } from 'lucide-react';
import { useReadStateUndo } from '../hooks/useReadStateUndo';
import { useAccountNoticeUnread } from '../hooks/useAccountNoticeUnread';
import {
  ContactWorkspaceNavigationContext,
  ProfileNavigationContext,
  ProfileNavigationGuardContext,
} from '../lib/profileNavigation';
import { isDataline } from '../lib/deviceAvatar';
import { contactProfileIdentity, sendTargetOf } from '../lib/conversationIdentity';
import {
  expectedOutgoingKeys as expectedKeysOf,
  isSeqRejected,
  outgoingSequenceRejected,
} from '../lib/outgoingAcknowledgment';
import { avatarFromGroupCode, avatarFromUin, resolveAvatar } from '../lib/avatarResolver';
import { cachedAvatarUrl } from '../lib/avatarCache';
import { isMineMessage } from '../lib/messageDirection';
import {
  messageSender,
  optimisticMessageSender,
  mergeMessageMembers,
  localProfileUser,
  createMemberUinLookup,
} from '../lib/messageSender';
import { isLocalOutgoingMessage } from '../lib/messageSelection';
import { messageBatchBlockReason } from '../lib/messageBatchAction';
import { deletionIdentity, shareDeletionIds } from '../lib/messageDeletion';
import type { LoadSelectionMessages } from '../lib/messageSelection';
import {
  mergeOptimisticInto,
  captureOutgoingAfterSeq,
  matchForwardMessages,
  type ComposerSubmission,
  type OutgoingRemoval,
} from '../lib/localOutgoing';
import { useFailedOutgoingRemoval } from '../hooks/useFailedOutgoingRemoval';
import { OutgoingQueue } from '../lib/outgoingQueue';
import { matchGeneratedMessages } from '../lib/generatedOutgoing';
import { newOutgoingRequestId, useOutgoingReceipts } from '../hooks/useOutgoingReceipts';
import { useTransferActivity } from '../lib/transferActivity';
import { TransferActivityProvider } from '../components/TransferActivityProvider';
import { readVideoMeta } from '../im-template/template/composerMedia';
import { releaseObjectUrl } from '../lib/objectUrl';
import { useDismissUnsentOutgoing } from '../hooks/useDismissUnsentOutgoing';
import { useOutgoingConversationPreviews } from '../hooks/useOutgoingConversationPreviews';
import { reconcileFileMessages } from '../lib/fileSendReconcile';
import {
  createUnreadRefresh,
  createUnreadTargetRefresh,
  createUnreadUpdateGuard,
  retryConversationRead,
  sameUnreadHighlights,
  UNREAD_BATCH_SIZE,
  createUnreadRefreshState,
} from '../lib/unreadRefresh';
import { flashShareCodeOfUrl } from '../lib/flashShare';
import {
  classifyFlashPhotoFetch,
  FLASH_PHOTO_MAX_ATTEMPTS,
  FLASH_PHOTO_PLACEHOLDER_TEXT,
  isFlashPhotoPlaceholderText,
  pickFlashPhotoFetch,
} from '../lib/flashPhoto';
import {
  loadFlashPhotoState,
  saveFlashPhotoState,
  type FlashPhotoPatch,
} from '../lib/flashPhotoPatchStore';
import { unreadChatType } from '@weq/codec';
import { replaceLoadedMembers, subscribeQQPeerUpdates } from '../lib/qqPeerUpdates';
import { draftSortTimes } from '@weq/service/conversation-order';
import {
  canPreviewContactMessage,
  mergeRecentContactPages,
  observeContactPreview,
  latestContactPreviewMessage,
  recentContactPreviewIsBehind,
  reconcileRecentContactPreviews,
  type ObservedContactPreview,
} from '../lib/recentContacts';
import {
  useContentSelectionScope,
  useRequestContentExport,
} from '../state/contentSelection.shared';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { conversationWindowKey } from '../lib/conversationWindowCache';
import { firstPageKey } from '../lib/conversationFirstPage';
import { applyReplyMedia, needsReplyMedia } from '../lib/replyMedia';
import { messageTemplateContext } from '../lib/messageTemplateContext';
import { useRecentContactHeadRefresh } from '../hooks/useRecentContactHeadRefresh';
import { useRecentContactTargets } from '../hooks/useRecentContactTargets';
import { useQQReadActivity } from '../hooks/useQQAutoRefresh';
import { useProfileResolver } from '../hooks/useProfileResolver';
import { useCloneTaskRefresh } from '../hooks/useCloneTaskRefresh';
import { useGeneratedReplyNotifications } from '../hooks/useGeneratedReplyNotifications';
import {
  GROUP_MEMBER_PREVIEW_REFRESH_MS,
  useGroupMemberResolver,
} from '../hooks/useGroupMemberResolver';
import { useGroupMemberSearch } from '../hooks/useGroupMemberSearch';
import {
  activeGroupMembers,
  createGroupMemberLookup,
  groupMemberPagesKey,
  groupMemberPagesOptions,
  refreshGroupMemberPages,
} from '../lib/groupMemberRefresh';
import { useDressSkin } from '../hooks/useDressSkin';
import { useDevelopmentDressTools } from '../hooks/useDevelopmentDressTools';
import { RailAccountFooter } from '../components/RailAccountFooter';
import { WorkspaceMenuButton, WorkspaceSettingsButton } from '../components/WorkspaceMenuButton';
import { useSettingsNavigation } from '../hooks/useSettingsNavigation';
import type { SectionId as SettingsDialogSectionId } from '../components/SettingsDialog';
import { remoteUnsupportedTools } from '../components/settings/DataMaintenanceSection.shared';
import type { MaintenanceTool } from '../components/settings/DataMaintenanceSection';
import { isRemoteClient } from '../lib/remoteClient';
import {
  SettingsDialog,
  DataMaintenanceDialog,
  CollectionDialog,
  QzoneWorkspace,
  ChannelView,
  DressUpDialog,
  GroupBugDialog,
  AgentLabView,
  AssistantConversationPane,
  GuildDirectDialog,
  AnnualReportView,
} from '../components/lazyWorkspaces';
import { useSettingsMaintenance } from '../hooks/useSettingsMaintenance';
import { useConversationMessageRecords } from '../hooks/useConversationMessageRecords';
import {
  QzoneAlbumDialog,
  GroupAlbumDialog,
  GroupFileDialog,
  GroupSignDialog,
  GroupEssenceDialog,
  GroupLeftMembersDialog,
  AddMessageModal,
  MergeForwardDialog,
  CompositionWorkspace,
  DeletedMessagesModal,
  RecalledMessagesModal,
  GapMessagesModal,
  ChatRecordsModal,
  MailWorkspace,
  SequentialForwardDialog,
  MsgElementEditor,
  SearchResultsPanel,
  WorkspaceTools,
  ChatHome,
  CallWindow,
  OfficialConversationPane,
  ContactNoticeDialog,
  GroupNoticeDialog,
  GroupAnnouncementsDialog,
  ConversationSettingsDialog,
  QQRemarkDialog,
  GroupMemberKickDialog,
  GroupMemberRenameDialog,
  GroupMemberTitleDialog,
  ConversationOverviewCalendar,
  MemberProfileCard,
  ConversationIdentityCard,
  SpecialConversationPreview,
  GroupProfileDialog,
  GroupTodos,
} from '../components/lazyMainPanels';
import { GroupAlbumCardNavigationProvider } from '../components/GroupAlbumCardNavigation';
import type { GroupBulletinWire } from '../components/GroupAnnouncementsDialog';
import { useDbRepairWindow } from '../state/dbRepairWindow';
import { useCaptureWindow } from '../state/captureWindow';
import {
  essenceSequences,
  essenceRefreshInterval,
  essenceSource,
  ESSENCE_RECEIPT_TTL,
  useQQEssence,
} from '../state/qqEssence';
import type { GroupInfoDetail, GroupSidebarFeature } from '../im-template/template/groupInfoPanel';
import {
  ConversationSettingsNavigationContext,
  GroupResourceNavigationContext,
  type ConversationSettingsRequest,
} from '../lib/conversationSettingsNavigation';
import { FriendDirectoryControls } from '../components/FriendDirectoryControls';
import { RelationshipDirectoryContext } from '../lib/contactRelationship';
import {
  projectGroupEssence,
  hasCompleteEssenceSnapshot,
  GROUP_ESSENCE_ONLINE_LIMIT,
} from '../lib/groupEssenceProjection';
import { sharedGroupConversation } from '../components/ark/groupShareCard';
import { openRedBagQrcode } from '../components/RedBagQrcodeDialog.shared';
import type { GroupLeftMemberRow } from '../components/GroupLeftMembersDialog';
import type { CompositionBinding } from '../components/mergeForward/workspaceModel';
import { useCompositionWindow } from '../hooks/useCompositionWindow';
import { useGroupResourceWindows } from '../hooks/useGroupResourceWindows.shared';
import {
  cleanNtPath,
  codecElementToSeg,
  codecElementsToSegs,
  createEmptyDraft,
  coerceDraft,
  createNode,
  draftCardPreview,
  draftTitle,
  draftToSendNodes,
  mfId,
  renderElementsToSegs,
  validateDraft,
  type MfDraft,
  type MfElement,
  type MfNode,
  type MfSeg,
  type MfTarget,
} from '../components/mergeForward/model';
import type { MfPerson } from '../components/mergeForward/SenderPicker';
import { isGeneratedSearchHit, isContentSearchHit } from '../components/search/types';
import { useGlobalSearch } from '../hooks/useGlobalSearch';
import { useSearchPreferences } from '../hooks/useSearchPreferences';
import { useSearchReturn } from '../hooks/useSearchReturn';
import { useSearchDismissal } from '../hooks/useSearchDismissal';
import type { AnalysisReportRequest, AnalysisToolRequest } from './analysis/model';
import { restoredAnalysisRequest } from './analysis/model';
import { useMessageNotifications } from '../hooks/useMessageNotifications';
import type { RoamingTarget } from '@weq/service';
import {
  conversationAnalysisTarget,
  conversationRoamingTarget,
  readonlyConversationKind,
} from '../lib/conversationActions';
import { fetchMissingContext } from '../lib/missingMessageFetch';
import { generatedMuteKey, preferenceDefaults } from '@weq/service/client-preferences';
import { createMediaId } from '../im-template/template/composerMedia';
import type {
  ChatRecordSearchHit,
  GeneratedSearchHit,
  SearchHit,
  ContentSearchTarget,
} from '../components/search/types';
import {
  ConversationDirectoryContext,
  ContactDirectoryContext,
  guildConversationRow,
  virtualConversationRow,
  type ConcreteConversation,
  type ConversationLocateRequest,
} from '../lib/conversationDirectory';
import type { OverlayAnchor } from '../lib/overlayAnchor.shared';
import {
  CONVERSATION_VIEWS,
  activeConversationBelongsToView,
  aggregateView,
  aggregatePinPreferences,
  conversationViewRows,
  conversationViewForTarget,
  conversationRowName,
  type ActiveDirectoryConversation,
  type ConversationView,
  type ConversationViewDirectory,
} from '../lib/conversationViews';
import {
  feedConversationRow,
  assistantConversationRow,
  generatedAggregateRow,
} from '../lib/conversationDirectoryRows';
import { conversationBatchSelection } from '../../../shared/content_selection';
import { displayUserName } from '../im-template/template/user';
import { isDatalineUid } from '@weq/codec';
import type { CalendarTarget as OverviewCalendarTarget } from '@weq/service/conversation-calendar';
import { CalendarNavigationContext, type CalendarNavigate } from '../lib/calendarNavigation';
import { conversationListSearchText } from '../lib/conversationListSearchText';
import { calendarCloneRevision, calendarAssistantRevision } from '../lib/calendarSourceRevision';
import { QzoneCardNavigationContext } from '../lib/qzoneNavigation';
import type { AppSearchEntry, ToolSearchRequest } from '../components/search/appSearchCatalog';
import type { DressKind } from '../components/DressUpDialog';
import type { SettingsSearchTarget } from '../components/settings/searchTarget';
import { WorkspaceContent, WorkspacePages } from '../components/WorkspacePages';
import { WorkspaceStartupLoading } from '../components/WorkspaceStartupLoading';
import { PanelLoading } from '../components/LoadingIndicator';
import { displayGroupMemberName } from '../im-template/template/user';
import {
  ChatNavigationContext,
  GroupMessagePreviewContext,
  GroupSpeechPreviewContext,
  type ProfileChatTarget,
} from '../lib/chatNavigation';
import { readProfilePreviewPage, type ProfilePreviewCursor } from '../lib/profileMessagePreview';
import { RetainedTabs } from '../components/RetainedTabs';
import { PageSnapshots } from '../components/PageSnapshots';
import { usePageState } from '../components/PageSnapshots.shared';
import { pageValue } from '../lib/pageSnapshots';
import { RendererRecoveryNotice } from '../components/RendererRecoveryNotice';
import {
  QzoneNavigationContext,
  QzoneProfileContext,
  type QzoneSpaceRequest,
} from '../lib/qzoneNavigation';
import { ChatMainContent } from '../im-template/template/chatMainContent';
import { ChatShell } from '../im-template/template/chatShell';
import { ChatSidebarContent } from '../im-template/template/chatSidebarContent';
import {
  composeMessageRenderers,
  type MessageRenderer,
} from '../im-template/template/messageRenderers';
import type {
  Contact,
  Conversation,
  ConversationHighlight,
  ConversationPreference,
  ConversationPreferences,
  UnreadDock,
  GroupMember,
  Message,
  User,
} from '../im-template/template/types';
import {
  buildFlashOptimisticElement,
  flashDescOf,
} from '../im-template/template/flashComposer.shared';
import type { FlashSendPayload } from '../im-template/template/flashComposer';
import {
  arkCardSignature,
  buildContactPlaceholderArk,
  buildGroupSignupArkJson,
  buildLocationArkJson,
  buildTuwenArkJson,
  type ArkContactSource,
  type ArkLocationProvider,
  type ArkPayload,
} from '../im-template/template/arkCards';
import type {
  FlashPhotoSendPayload,
  BubbleVideoSendPayload,
} from '../im-template/template/chatPane';
import type { RedPacketDraft } from '../im-template/template/redPacketPanel';
import { useChatShellController } from '../im-template/template/shellController';
import { toIpcElements } from '../im-template/template/draftElements';
import { buildUnreadDock } from '../im-template/template/unreadDock';
import {
  buildComposerSendPlan,
  composerNeedsStickerCatalog,
  buildOptimisticRender,
  composerSendError,
  resolveComposerMedia,
  decodeRecordingToWav,
  type LocalMediaRef,
  type ComposerSendPlan,
  type SuperStickerEntry as ComposerSuperSticker,
} from '../im-template/template/composerSend';
import {
  repeatSendPlan,
  repeatImageSources,
  repeatNeedsStickerCatalog,
  type RepeatElement,
} from '../lib/messageRepeat';
import { forwardMessageBlockReason, partitionForwardMessages } from '../lib/sequentialForward';
import {
  resolveMentionLabels,
  resolveSendMentions,
  type MentionIdentity,
} from '../lib/mentionIdentity';
import { qqMessageRenderer } from '../components/QqMessageContent.shared';
import { ReplyJumpContext, ForwardKindContext, ConvContext } from '../state/messageContext';
import type { ReplyJumpTarget } from '../components/QqMessageContent';

const AnalysisReportPage = lazy(() =>
  import('./analysis/AnalysisReportPage').then((module) => ({
    default: module.AnalysisReportPage,
  })),
);
const SearchGroupContentResult = lazy(() =>
  import('../components/search/SearchGroupContentResult').then((module) => ({
    default: module.SearchGroupContentResult,
  })),
);
const QzonePublicSearchResult = lazy(() =>
  import('./QzonePublicView').then((module) => ({ default: module.QzonePublicSearchResult })),
);
const SearchFlashTransferViewer = lazy(() =>
  import('../components/FlashTransferViewer').then((module) => ({
    default: module.FlashTransferViewer,
  })),
);
const RelationGraphView = lazy(() =>
  import('../components/relationGraph/RelationGraphView').then((module) => ({
    default: module.RelationGraphView,
  })),
);
const workspaceLoading = <PanelLoading />;

const messageRenderers: MessageRenderer[] = composeMessageRenderers({
  prepend: [qqMessageRenderer],
});

function calendarTargetForConversation(row: ConcreteConversation): OverviewCalendarTarget {
  const generated = row.generated;
  const kind =
    generated?.kind === 'group'
      ? 'cloneGroup'
      : (generated?.kind ??
        readonlyConversationKind(row) ??
        (row.type === 'group' ? 'group' : isDatalineUid(row.id) ? 'dataline' : 'c2c'));
  return {
    kind,
    conv:
      generated?.kind === 'assistant'
        ? (generated.sessionId ?? row.id.replace(/^assistant:/, ''))
        : (generated?.ownerId ?? row.id.replace(/^(guild|service):/, '')),
    name: conversationRowName(row),
    avatar: row.type === 'group' ? row.group.avatarUrl : (row.otherUser.avatarUrl ?? null),
    ancestors: [],
    searchText: conversationListSearchText(row),
  };
}

function isMobileShell(): boolean {
  return isSingleColumnLayout();
}

export function MainView(): ReactElement {
  const queryClient = useQueryClient();
  const uin = useViewState((state) => state.openedUin);
  const startupPage = useViewState((state) => state.startupPage);
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: Boolean(uin) });
  const scope =
    config.data?.uin === uin && config.data.configId
      ? JSON.stringify([uin, config.data.configId])
      : null;
  const configId = config.data?.configId;
  useEffect(() => {
    if (!IS_WEB || !scope || !uin || !configId) return;
    void queryClient.prefetchQuery(
      recentContactHeadOptions({ expectedAccountUin: uin, expectedAccountConfigId: configId }),
    );
  }, [queryClient, scope, uin, configId]);
  if (config.isLoading) return <WorkspaceStartupLoading />;
  const workspace = (
    <PageSnapshots scope={scope} resetOnMount={startupPage !== null}>
      <TransferActivityProvider
        key={scope ?? `pending:${uin ?? ''}`}
        binding={
          scope && uin && configId
            ? { expectedAccountUin: uin, expectedAccountConfigId: configId }
            : null
        }
      >
        <MainWorkspace />
      </TransferActivityProvider>
    </PageSnapshots>
  );
  return IS_WEB && scope ? (
    <WebBusinessCache
      key={scope}
      scope={JSON.stringify([location.origin, scope])}
      fallback={<WorkspaceStartupLoading />}
    >
      {workspace}
    </WebBusinessCache>
  ) : (
    workspace
  );
}

function MainWorkspace(): ReactElement {
  const transferActivity = useTransferActivity();
  const firstPageStreamReady = useWebConnection((state) => state.status === 'connected');
  const [startupView] = useState(() => useViewState.getState().startupPage);
  useEffect(() => {
    useViewState.setState({ startupPage: null });
  }, []);
  const [mailUnread, setMailUnread] = useState(0);
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const [contactsPageOpen, setContactsPageOpen] = useState(false);
  const [startupStage, setStartupStage] = useState<StartupQueryStage>(0);
  const directoryReady = startupStage >= 1;
  const groupsReady = startupStage >= 2;
  const profilesReady = startupStage >= 3;
  const secondaryReady = startupStage >= 4;
  const onlineReady = startupStage >= 5;
  const initialMessagesPendingRef = useRef(false);
  const directoryOptions = {
    enabled: directoryReady || contactsPageOpen,
    staleTime: IS_WEB ? 60_000 : 5 * 60_000,
    refetchOnMount: IS_WEB,
  } as const;
  const profileOptions = { ...directoryOptions, enabled: profilesReady || contactsPageOpen };
  const onlineOptions = { ...directoryOptions, enabled: onlineReady };
  const pushToast = useToast((s) => s.push);
  const confirmReadState = useDialog((s) => s.confirm);
  const pinSession = useQQWriteSession('conversation-pin');
  const configId = pinSession.binding?.expectedAccountConfigId;
  useContactNoticeUpdates(pinSession.binding);
  const messageScope = pinSession.binding
    ? JSON.stringify([
        pinSession.binding.expectedAccountUin,
        pinSession.binding.expectedAccountConfigId,
      ])
    : '';
  useEffect(() => {
    useWorkspaceMenu.setState({ taskFocusId: null });
  }, [messageScope]);
  useContentSelectionScope(messageScope);
  const messageActivity = useQQReadActivity(Boolean(messageScope), { onlineOnly: false });
  const [visibleConversationIds, setVisibleConversationIds] = useState<readonly string[]>([]);

  const messageWindow = useMessageWindowState({
    messageScope,
    binding: pinSession.binding,
    messageActivity,
    setVisibleConversationIds,
  });
  const {
    messageScopeRef,
    messageBindingRef,
    conversationWindows,
    dbRevisionRef,
    loadedRevisionRef,
    windowVerifiedAtRef,
    verifiedWindowRowsRef,
    cachedScrollRef,
    initialReadingPosition,
    loadingNewerMessages,
    loaded,
    nativeMessageScrollRef,
    captureNativeTimeline,
    anchoredToLatest,
    setAnchoredToLatest,
    selectionRef,
    setLoaded,
    firstPages,
    prefetchVisible,
    prefetchIntent,
    attemptedReplyMedia,
    replyMediaRows,
    replyMediaRevision,
    setReplyMediaRevision,
    windowRef,
    refreshWindow,
    hasOlder,
    setHasOlder,
    setHasNewer,
    messagesLoading,
    setMessagesLoading,
    trackedConversationId,
    trackedMessageScope,
    loadedRef,
    pendingScrollRestoreRef,
    pendingSearchJumpRef,
  } = messageWindow;
  const pinMutation = trpc.account.qqWrite.pin.useMutation();
  useEffect(() => {
    if (pinSession.result)
      pushToast({
        tone: pinSession.result.error ? 'error' : 'info',
        title: pinSession.result.text,
      });
  }, [pinSession.result, pushToast]);
  // 群成员管理（改群昵称 / 踢人）：弹窗挂在本层（与群公告 / 群精华同层），发包也在这里。
  const renameGroupMember = trpc.account.setGroupMemberCard.useMutation();
  const kickGroupMember = trpc.account.kickGroupMember.useMutation();
  const { contacts, head: recentHead } = useRecentContactQueries(
    pinSession.binding,
    messageActivity.enabled,
  );
  const refreshRecentTargets = useRecentContactTargets(
    pinSession.binding,
    messageActivity.enabled,
    visibleConversationIds,
  );
  const firstContactsReady = Boolean(contacts.data) || contacts.isError;
  // Remote 的常规视图在首批会话可用后就补齐各聚合入口，缓存先显示并立即向宿主校准。
  const regularDirectoryReady =
    Boolean(pinSession.binding) && (firstContactsReady || Boolean(recentHead.data));
  const regularDirectoryOptions = {
    ...directoryOptions,
    staleTime: IS_WEB ? 0 : directoryOptions.staleTime,
    enabled: IS_WEB ? regularDirectoryReady : secondaryReady,
  };
  const conversationPagingReady = IS_WEB ? regularDirectoryReady : secondaryReady;
  const canContinueConversationPaging = useStableCallback(
    () =>
      !initialMessagesPendingRef.current &&
      (IS_WEB
        ? !recentHead.isFetching && !topContacts.isFetching && !conversationDraftTimes.isFetching
        : queryClient.isFetching() === 0),
  );
  const conversationDraftTimes = trpc.account.listConversationDraftTimes.useQuery(
    pinSession.binding ?? undefined,
    { enabled: Boolean(pinSession.binding), keepPreviousData: false, staleTime: 0 },
  );
  const draftTimesByConv = useMemo(
    () => draftSortTimes(conversationDraftTimes.data ?? []),
    [conversationDraftTimes.data],
  );
  // Folder membership must cover older rows too; never classify unobserved groups as folded.
  useEffect(() => {
    if (contacts.hasNextPage && !contacts.isFetching && !contacts.error) {
      if (!conversationPagingReady || !contacts.isFetchedAfterMount) return;
      return scheduleStartupQueryBatch(() => {
        void contacts.fetchNextPage();
      }, canContinueConversationPaging);
    }
  }, [
    contacts.hasNextPage,
    contacts.isFetching,
    contacts.error,
    contacts.data?.pages.length,
    contacts.fetchNextPage,
    conversationPagingReady,
    canContinueConversationPaging,
    contacts.isFetchedAfterMount,
  ]);
  useEffect(() => {
    if (
      !conversationPagingReady ||
      !contacts.data ||
      contacts.isFetchedAfterMount ||
      contacts.isFetching ||
      recentHead.isFetching
    )
      return;
    const binding = messageBindingRef.current;
    const source = messageScope;
    return scheduleStartupQueryBatch(() => {
      const headInput = { limit: RECENT_HEAD_SIZE, cursor: 0, ...binding };
      const previousHead = utils.account.listRecentContacts.getData(headInput);
      void contacts.refetch().then((result) => {
        if (result.isError || !result.data || messageScopeRef.current !== source) return;
        // 全目录校准完成后清掉旧页里已删除的会话，不覆盖更晚的实时 head。
        if (utils.account.listRecentContacts.getData(headInput) !== previousHead) return;
        utils.account.listRecentContacts.setData(headInput, result.data.pages[0]);
      });
    }, canContinueConversationPaging);
  }, [
    conversationPagingReady,
    canContinueConversationPaging,
    contacts.data,
    contacts.isFetchedAfterMount,
    contacts.isFetching,
    contacts.refetch,
    recentHead.isFetching,
    utils,
    messageScope,
    messageBindingRef,
    messageScopeRef,
  ]);
  const topContacts = trpc.account.listTopContacts.useQuery(
    {
      expectedAccountUin: pinSession.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: pinSession.binding?.expectedAccountConfigId ?? '',
    },
    {
      enabled: Boolean(pinSession.binding),
      keepPreviousData: false,
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: 'always',
      refetchOnReconnect: 'always',
    },
  );
  const refreshRecentHead = useRecentContactHeadRefresh(recentHead.refetch, messageScope);
  useEffect(() => {
    const refresh = () => {
      if (messageScopeRef.current && document.visibilityState !== 'hidden') {
        refreshRecentHead();
        refreshRecentTargets();
      }
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [refreshRecentHead, refreshRecentTargets, messageScopeRef]);

  // Flatten the paginated recent-contact pages into one list for the memos
  // below (the sidebar can scroll-load more pages past the first window).
  const rawRecentContactsData = useMemo<RecentContactWire[]>(
    () =>
      mergeRecentContactPages([
        recentHead.data?.items ?? [],
        ...(contacts.data?.pages ?? []).map((page) => page.items),
      ]),
    [contacts.data, recentHead.data],
  );
  const [observedContactPreviews, setObservedContactPreviews] = useState<
    ReadonlyMap<string, ObservedContactPreview>
  >(() => new Map());
  const previousContactSummaries = useRef<ReadonlyMap<string, RecentContactWire>>(new Map());
  const contactPreviews = useMemo(
    () =>
      reconcileRecentContactPreviews(
        rawRecentContactsData,
        previousContactSummaries.current,
        observedContactPreviews,
      ),
    [rawRecentContactsData, observedContactPreviews],
  );
  useLayoutEffect(() => {
    previousContactSummaries.current = contactPreviews.summaries;
  }, [contactPreviews]);
  const recentContactsData = contactPreviews.rows;
  const allGroups = trpc.account.listAllGroups.useQuery(
    { limit: 2000 },
    {
      ...regularDirectoryOptions,
      enabled: groupsReady || contactsPageOpen || (IS_WEB && regularDirectoryReady),
    },
  );
  // Official QQ setting: observed 4 → 2 when switching from muted to group helper.
  const previousGroupAssistantIds = useRef(new Set<string>());
  const groupAssistantIds = useMemo(() => {
    const ids = new Set(
      recentContactsData
        .filter(
          (contact) => chatTypeKind(contact.chatType) === 'group' && contact.notifyLevel === 2,
        )
        .map((contact) => contact.targetUid),
    );
    for (const group of (allGroups.data ?? []) as GroupDetailWire[]) {
      if (group.directory?.notifyLevel === 2) ids.add(group.groupCode);
    }
    const previous = previousGroupAssistantIds.current;
    return previous.size === ids.size && [...ids].every((id) => previous.has(id)) ? previous : ids;
  }, [recentContactsData, allGroups.data]);
  useLayoutEffect(() => {
    previousGroupAssistantIds.current = groupAssistantIds;
  }, [groupAssistantIds]);
  const groupAssistantEntry = useMemo(
    () =>
      recentContactsData.find(
        (contact) => contact.chatType === 'KCHATTYPEGROUPHELPER' || Number(contact.chatType) === 7,
      ),
    [recentContactsData],
  );
  const contactsHasMore = Boolean(contacts.hasNextPage);
  const contactsLoadingMore = contacts.isFetchingNextPage;
  const loadMoreContacts = (): void => {
    if (contacts.hasNextPage && !contacts.isFetchingNextPage) {
      void contacts.fetchNextPage();
    }
  };
  const hiddenSessions = trpc.account.listHiddenSessions.useQuery(
    undefined,
    regularDirectoryOptions,
  );
  const deletedSessions = trpc.account.listDeletedSessions.useQuery(
    undefined,
    regularDirectoryOptions,
  );
  const officialAccounts = trpc.account.listOfficialAccounts.useQuery(
    undefined,
    regularDirectoryOptions,
  );
  const serviceAccounts = trpc.account.listServiceAccounts.useQuery(
    undefined,
    regularDirectoryOptions,
  );
  // 频道私聊聚合入口：与公众号一样只取「有没有 / 最新一条」，详情在展开面板里拉。
  const guildDirectSessions = trpc.account.guildDirectListSessions.useQuery(
    undefined,
    regularDirectoryOptions,
  );
  const guildConversationRows = useMemo(
    () => (guildDirectSessions.data ?? []).map(guildConversationRow),
    [guildDirectSessions.data],
  );
  const selfProfile = trpc.account.getSelfProfile.useQuery(undefined, {
    ...directoryOptions,
    enabled: Boolean(pinSession.binding),
  });
  const displaySettings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  // 与互动标识等在线能力使用同一套前置条件：QQ 账号在线，且没有开启
  // 「完全离线模式」（自动读取 QQ 内存 总闸开启）。状态未读到前按不可发送处理。
  const sendAccess = trpc.account.getGroupAlbumAccessState.useQuery(undefined, {
    refetchOnWindowFocus: true,
    staleTime: 4000,
    refetchInterval: 5000,
  });
  // 发送能力总闸：QQ 在线 + 未开完全离线模式，且本地账号配置里 a2 / d2 / d2key / guid
  // 都非空（发包要拿它们做 TEA 加密与设备身份）。缺任一项发送键就置灰。
  const sendAvailable = Boolean(
    sendAccess.data?.qqOnline &&
      sendAccess.data.attachEnabled &&
      sendAccess.data.hasA2 &&
      sendAccess.data.hasD2 &&
      sendAccess.data.hasD2Key &&
      sendAccess.data.hasGuid,
  );
  const groupBugStatus = trpc.groupFeedback.status.useQuery(undefined, {
    enabled: onlineReady,
    refetchOnWindowFocus: true,
    staleTime: 8000,
  });
  const buddies = trpc.account.listBuddies.useQuery({ limit: 2000 }, directoryOptions);
  const botUidList = trpc.account.botUids.useQuery(undefined, profileOptions);
  const categories = trpc.account.listCategories.useQuery(undefined, directoryOptions);
  const profiles = trpc.account.listProfiles.useQuery({ limit: 2000 }, profileOptions);
  const noticeOptions = { enabled: secondaryReady || contactsPageOpen, staleTime: 60_000 };
  const buddyRequests = trpc.account.listBuddyRequests.useQuery(
    { limit: CONTACT_NOTICE_LIMIT },
    noticeOptions,
  );
  const groupNotifies = trpc.account.listGroupNotifies.useQuery(
    { limit: CONTACT_NOTICE_LIMIT },
    noticeOptions,
  );
  const openedUin = useViewState((s) => s.openedUin);
  const user = useMemo(
    () => currentUser(openedUin, selfProfile.data),
    [openedUin, selfProfile.data],
  );
  const mailPreferences = trpc.mail.preferences.useQuery(
    { selfUin: openedUin ?? '' },
    { enabled: Boolean(openedUin) && onlineReady, staleTime: 0, refetchOnMount: 'always' },
  );
  const specialCareUnavailable = specialCareBlocker(sendAccess.data);
  const specialCare = trpc.account.specialCare.useQuery(
    { selfUin: openedUin ?? '' },
    {
      enabled: onlineReady && Boolean(openedUin && specialCareUnavailable === null),
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: true,
      retry: false,
    },
  );
  const batchSettled = (
    startupStage === 1
      ? [buddies, categories]
      : startupStage === 2
        ? [allGroups]
        : startupStage === 3
          ? [profiles, botUidList]
          : startupStage === 4
            ? [
                hiddenSessions,
                deletedSessions,
                officialAccounts,
                serviceAccounts,
                guildDirectSessions,
              ]
            : []
  ).every((query) => query.isFetched && !query.isFetching);
  const essentialReady = firstContactsReady && selfProfile.isFetched;
  useEffect(() => {
    const next = nextStartupQueryStage(startupStage, essentialReady, batchSettled);
    if (next === null) return;
    return scheduleStartupQueryBatch(
      () => setStartupStage(next),
      () => !initialMessagesPendingRef.current && queryClient.isFetching() === 0,
    );
  }, [startupStage, essentialReady, batchSettled, queryClient]);
  const [refreshingContacts, setRefreshingContacts] = useState(false);
  const refreshingContactsRef = useRef(false);
  const refreshContacts = async (): Promise<void> => {
    const pushToast = sourceToastPush(
      notificationSource({ kind: 'app', target: { kind: 'view', view: 'contacts' } }),
    );
    if (refreshingContactsRef.current) return;
    const accountUin = openedUin;
    refreshingContactsRef.current = true;
    setRefreshingContacts(true);
    try {
      const results = await Promise.all([
        buddies.refetch(),
        categories.refetch(),
        profiles.refetch(),
        refreshProfileCache()
          .then(() => ({ isError: false }))
          .catch(() => ({ isError: true })),
        client.account.botUids
          .query({ refresh: true })
          .then((data) => {
            if (useViewState.getState().openedUin === accountUin)
              utils.account.botUids.setData(undefined, data);
            return { isError: false };
          })
          .catch(() => ({ isError: true })),
        allGroups.refetch(),
        contacts.refetch(),
        hiddenSessions.refetch(),
        deletedSessions.refetch(),
        buddyRequests.refetch(),
        groupNotifies.refetch(),
        ...(specialCareUnavailable === null ? [specialCare.refetch()] : []),
      ]);
      if (
        useViewState.getState().openedUin === accountUin &&
        results.some((result) => result.isError)
      )
        pushToast({
          tone: 'info',
          durationKind: 'failure',
          title: '部分联系人数据刷新失败，已保留上次结果',
        });
    } catch {
      if (useViewState.getState().openedUin === accountUin)
        pushToast({ tone: 'info', durationKind: 'failure', title: '联系人刷新失败，请稍后重试' });
    } finally {
      refreshingContactsRef.current = false;
      setRefreshingContacts(false);
    }
  };

  // ARK Feed 显示状态（公众号/服务号消息流）
  const [arkFeedState, setArkFeedState] = useState<{
    kind: 'official' | 'service';
    conversationId: string;
    title: string;
    anchorId?: string;
  } | null>(null);

  /**
   * 闪照补拉到的真元素，按**本地** `msgId` 存（补拉那条的 msgId 与本地行不同，
   * 只有 seq 相同）。不能直接写进 `loaded`：`refreshWindow` 会在消息活动 / SSO
   * 事件后从本地库整页重读并 `setLoaded(rows)`，把替换冲掉。
   */
  const [flashPhotoPatches, setFlashPhotoPatches] = useState(
    () => new Map<string, FlashPhotoPatch>(),
  );
  /** 服务端确认补不回来的本地 msgId（切会话也不丢，见 flashPhotoPatchStore）。 */
  const [flashPhotoDead, setFlashPhotoDead] = useState(() => new Set<string>());
  // 写盘要在 setState 的 updater 之外拿「另一个集合」的最新值，用 ref 镜像一份。
  const flashPhotoPatchesRef = useRef(flashPhotoPatches);
  const flashPhotoDeadRef = useRef(flashPhotoDead);
  flashPhotoPatchesRef.current = flashPhotoPatches;
  flashPhotoDeadRef.current = flashPhotoDead;
  /** 把当前会话的补丁 + 判死集合写回 sessionStorage。 */
  const persistFlashPhotoState = useCallback(
    (conv: string, patches: Map<string, FlashPhotoPatch>, dead: Set<string>): void => {
      saveFlashPhotoState(conv, {
        patches: Object.fromEntries(patches),
        dead: [...dead],
      });
    },
    [],
  );
  const [calendarDataRevision, setCalendarDataRevision] = useState(0);
  const calendarOpenRef = useRef(false);

  useEffect(() => {
    const binding = messageBindingRef.current;
    if (!messageScope || !binding) return;
    const sub = client.account.onRoamingMessages.subscribe(binding, {
      onData(change) {
        if (messageScopeRef.current !== messageScope) return;
        if (calendarOpenRef.current) setCalendarDataRevision((revision) => revision + 1);
        conversationWindows.markDirty(
          conversationWindowKey(messageScope, change.kind, change.conv),
        );
        // WeQ 发送缓存不会改 QQ 库，也就不会触发 onDbChanged。
        refreshRecentHead();
        refreshRecentTargets([change.conv]);
        const selection = selectionRef.current;
        if (
          !selection ||
          selection.id !== change.conv ||
          (selection.kind === 'group' ? 'group' : 'c2c') !== change.kind
        )
          return;
        setLoaded((current) => {
          if (selectionRef.current !== selection) return current;
          return mergeRoamingWindow(change.kind, current, change.messages.map(toMessageWire));
        });
      },
      onError(error) {
        console.error('[roaming] cache subscription failed', error);
      },
    });
    return () => sub.unsubscribe();
  }, [
    utils,
    messageScope,
    conversationWindows,
    refreshRecentHead,
    refreshRecentTargets,
    setLoaded,
    messageBindingRef,
    messageScopeRef,
    selectionRef,
  ]);

  // Subscribe once to the debounced "db changed" ping: refresh recent contacts
  // and re-read the open conversation's window. (onNewMessages stays a backend
  // signal reserved for future popups; the open view no longer needs it.)
  useEffect(() => {
    const binding = messageBindingRef.current;
    if (!messageScope || !binding) return;
    // 文件事件不知道变了哪张表；低频校准辅助目录，正文与角标仍走即时通道。
    const metadataRefresh = createUnreadRefresh(async () => {
      if (messageScopeRef.current !== messageScope) return true;
      await Promise.all([
        utils.account.listTopContacts.invalidate(),
        utils.account.listHiddenSessions.invalidate(),
        utils.account.listOfficialAccounts.invalidate(),
        utils.account.listServiceAccounts.invalidate(),
        utils.account.listConversationDraftTimes.invalidate(),
        utils.account.listDrafts.invalidate(),
      ]);
      return true;
    }, 5000);
    const unknownRefresh = createUnreadRefresh(async () => {
      if (messageScopeRef.current !== messageScope) return true;
      refreshRecentHead();
      refreshRecentTargets();
      return true;
    }, 1000);
    const sub = client.account.onDbChanged.subscribe(binding, {
      onData(notice) {
        if (messageScopeRef.current !== messageScope) return;
        if (!IS_WEB && notice?.at) recordMessagePhase('observedToRenderer', Date.now() - notice.at);
        dbRevisionRef.current += 1;
        conversationWindows.markDirty();
        // 灰条可共用旧序号且不改变未读数；正文不等待一秒目录校准。
        void refreshWindow();
        // Read watermarks can change while recent contacts remain identical.
        unknownRefresh.request();
        metadataRefresh.request();
      },
      onError(err) {
        console.error('[live] onDbChanged subscription error', err);
      },
    });
    return () => {
      metadataRefresh.dispose();
      unknownRefresh.dispose();
      sub.unsubscribe();
    };
  }, [
    utils,
    refreshWindow,
    messageScope,
    conversationWindows,
    refreshRecentHead,
    refreshRecentTargets,
    messageBindingRef,
    messageScopeRef,
    dbRevisionRef,
  ]);

  useEnhancementUpdates();

  useEffect(() => {
    const sub = client.update.onEvent.subscribe(undefined, {
      onData(e) {
        if ((e.kind === 'available' || e.kind === 'downloaded') && e.latest) {
          useToast.getState().push({
            event: 'update',
            key: 'weq-update',
            title: e.kind === 'downloaded' ? '新版本已下载，等待安装' : `发现新版本 ${e.latest}`,
            source: notificationSource({
              kind: 'app',
              target: { kind: 'setting', section: 'version' },
            }),
          });
        }
      },
      onError(err) {
        console.error('[update] onEvent subscription error', err);
      },
    });
    return () => sub.unsubscribe();
  }, []);

  const [conversationPrefs, setConversationPrefs] = useState<ConversationPreferences>({});
  useEffect(() => {
    if (!topContacts.data) return;
    const pinned = new Set(topContacts.data.map((row) => row.targetId));
    setConversationPrefs((current) => {
      let changed = false;
      const next = { ...current };
      for (const [id, preference] of Object.entries(current))
        if (/^(?:u_[A-Za-z0-9_-]+|[1-9]\d*)$/.test(id) && preference.pinned !== pinned.has(id)) {
          next[id] = { ...preference, pinned: pinned.has(id) };
          changed = true;
        }
      return changed ? next : current;
    });
  }, [topContacts.data]);
  const [groupAssistantPins, setGroupAssistantPins] = useState(() =>
    loadGroupAssistantPins(openedUin ?? ''),
  );
  useEffect(() => {
    const refresh = () => setGroupAssistantPins(loadGroupAssistantPins(openedUin ?? ''));
    window.addEventListener('weq-shared-account-state', refresh);
    return () => window.removeEventListener('weq-shared-account-state', refresh);
  }, [openedUin]);
  const mergeForwardVersions = useMemo(() => new Map<string, string | null>(), [messageScope]);
  const settingsNavigation = useSettingsNavigation();
  const unreadMarkers = useUnreadMarkers();
  const [settingsOpen, setSettingsOpen] = usePageState(
    'workspace:settings',
    false,
    pageValue.boolean,
  );
  const [settingsSearchTarget, setSettingsSearchTarget] = useState<SettingsSearchTarget | null>(
    null,
  );
  const [toolSearchRequest, setToolSearchRequest] = useState<ToolSearchRequest | null>(null);
  const {
    categories: searchCategories,
    setCategories: setSearchCategories,
    appEnabled: appSearchEnabled,
    setAppEnabled: setAppSearchEnabled,
    numberLookupEnabled,
    setNumberLookupEnabled,
    sources: searchSources,
    setSources: setSearchSources,
  } = useSearchPreferences();
  const [conversationView, setConversationView] = usePageState<ConversationView>(
    'workspace:conversation-view',
    'regular',
    z.enum(CONVERSATION_VIEWS),
  );
  const [returnToRegular, setReturnToRegular] = useState(false);
  const changeConversationView = useCallback(
    (view: ConversationView, fromAggregate = false) => {
      setReturnToRegular(fromAggregate && conversationView === 'regular');
      setConversationView(view);
    },
    [conversationView, setConversationView],
  );
  const switchConversationView = useStableCallback(
    (view: ConversationView, fromAggregate: boolean = false) => {
      if (
        view !== conversationView &&
        preferenceValue('closeConversationOutsideView') &&
        activeDirectoryConversation &&
        !activeConversationBelongsToView(
          conversationViews,
          view,
          allConversationOptions,
          activeDirectoryConversation,
        )
      ) {
        flushAllDirtyDrafts();
        if (shell.view === 'agentlab') {
          setVirtualOpen(null);
          setCloneSearchTarget(null);
        }
        setSpecialChat(null);
        setArkFeedState(null);
        setMobileConversationList(true);
        shell.openConversation(null);
      }
      changeConversationView(view, fromAggregate);
    },
  );
  const conversationViewsRef = useRef<ConversationViewDirectory | null>(null);
  const [specialChat, setSpecialChat] = useState<'assistant' | 'guild' | null>(null);
  const mobileLayout = useMobileWebLayout();
  const [mobileConversationList, setMobileConversationList] = useState(false);
  const [assistantSessionId, setAssistantSessionId] = useState<string | null>(null);
  const [assistantVisited, setAssistantVisited] = useState(false);
  const [deletedAssistantSessions, setDeletedAssistantSessions] = useState<string[]>([]);
  const [conversationLocate, setConversationLocate] = useState<ConversationLocateRequest | null>(
    null,
  );
  const [unreadConversationCycle] = useState(createUnreadConversationCycle);
  const requestConversationExport = useRequestContentExport();
  const openAssistantConversation = useStableCallback(
    (sessionId: string, searchTarget?: GeneratedSearchHit): void => {
      flushAllDirtyDrafts();
      setSettingsOpen(false);
      setAssistantVisited(true);
      setMobileConversationList(false);
      setAssistantSessionId(sessionId);
      setAssistantSearchTarget(searchTarget ?? null);
      setSpecialChat('assistant');
      setArkFeedState(null);
      setConversationLocate({ id: `assistant:${sessionId}`, revision: Date.now() });
      shell.switchView('messages');
    },
  );
  const locateConversationInView = useCallback(
    (id: string, preferred?: ConversationView) => {
      const directory = conversationViewsRef.current;
      const view = preferred ?? conversationViewForTarget(directory, id);
      setReturnToRegular(false);
      setConversationView(view);
      setConversationLocate({ id, revision: Date.now() });
    },
    [setConversationView],
  );
  useClientPreferences((state) => state.tick);
  const includeHiddenConversations = preferenceValue('allConversationsIncludeHidden');
  const includeDeletedConversations = preferenceValue('allConversationsIncludeDeleted');
  const allConversationOptions = useMemo(
    () => ({
      includeHidden: includeHiddenConversations,
      includeDeleted: includeDeletedConversations,
    }),
    [includeHiddenConversations, includeDeletedConversations],
  );
  useEffect(() => {
    if (!settingsOpen) setSettingsSearchTarget(null);
  }, [settingsOpen]);
  useEffect(() => {
    setToolSearchRequest(null);
    setSettingsSearchTarget(null);
  }, [messageScope]);

  /** 任务、更新提醒与独立窗口共用设置跳转入口。 */
  useEffect(
    () =>
      onOpenSettingsRequest((section) => {
        if (section === 'weqAssistant') {
          setSettingsSearchTarget(null);
          setSettingsSection('weq-assistant');
          setSettingsOpen(true);
          return;
        }
        if (section === 'dataSaver') {
          setSettingsSection('resource-loading');
          setSettingsSearchTarget({
            section: 'resource-loading',
            settingId: 'data-saver',
            revision: Date.now(),
          });
          setSettingsOpen(true);
          return;
        }
        if (section === 'enhancementPacks') {
          setSettingsSearchTarget(null);
          setSettingsSection('enhancement-packs');
          setSettingsOpen(true);
          return;
        }
        if (section === 'longTermAuthorization') {
          setSettingsSection('account');
          setSettingsSearchTarget({
            section: 'account',
            settingId: 'long-term-authorization',
            revision: Date.now(),
          });
          setSettingsOpen(true);
          return;
        }
        if (section !== 'callRecording') return;
        setSettingsSection('call-recording');
        setSettingsOpen(true);
      }),
    [setSettingsOpen],
  );
  const [surfaceNavigation, setSurfaceNavigation] = useState(0);
  /** 打开设置时要先落到哪一屏（损坏弹窗 → 数据库宽容）。 */
  const [settingsSection, setSettingsSection] = useState<SettingsDialogSectionId | undefined>(
    undefined,
  );
  useEffect(() => {
    const open = (event: Event) => {
      const request = (event as CustomEvent<NotificationSettingsRequest>).detail;
      settingsNavigation.navigate(() => {
        if (request.conversation && request.source !== JSON.stringify(sharedAccountBinding()))
          return;
        setSettingsSection('global');
        setSettingsSearchTarget({ section: 'global', ...request, revision: Date.now() });
        setSettingsOpen(true);
      });
    };
    window.addEventListener(OPEN_NOTIFICATION_SETTINGS, open);
    return () => window.removeEventListener(OPEN_NOTIFICATION_SETTINGS, open);
  }, [settingsNavigation, setSettingsOpen]);
  const { tool: maintenanceTool, setTool: setMaintenanceTool } =
    useSettingsMaintenance(messageScope);
  useEffect(() => () => useCaptureWindow.getState().dismiss(messageScope), [messageScope]);
  function openMaintenance(tool: MaintenanceTool) {
    if (messageScopeRef.current !== messageScope) return;
    if (isRemoteClient() && remoteUnsupportedTools.includes(tool)) {
      pushToast({ tone: 'info', title: '此项仅在电脑端支持' });
      return;
    }
    if (tool === 'capture') {
      if (!messageScope) {
        pushToast({
          tone: 'warning',
          title: '当前账号与数据源尚未就绪',
          source: notificationSource({
            kind: 'app',
            target: { kind: 'setting', section: 'account' },
          }),
        });
        return;
      }
      setMaintenanceTool(null);
      useCaptureWindow.getState().open(messageScope, openedUin ?? '');
      return;
    }
    if (tool === 'db-repair') {
      setMaintenanceTool(null);
      useDbRepairWindow.getState().open({
        uin: openedUin ?? '',
        configId,
        name: user.displayName,
        avatarUrl: user.avatarUrl ?? '',
      });
      return;
    }
    setMaintenanceTool(tool);
  }
  const [qzoneAlbumOpen, setQzoneAlbumOpen] = useState(false);
  const [temporaryConversations, setTemporaryConversations] = useState<
    Record<string, { conversation: Conversation; appearedAt: number }>
  >({});
  const [qzoneSpaceRequest, setQzoneSpaceRequest] = useState<QzoneSpaceRequest | null>(null);
  /** 空间页当前所在的空间 QQ 号（浮动工具按当前位置导出）。 */
  const [currentQzoneUin, setCurrentQzoneUin] = useState<string | null>(null);
  /** 频道私聊当前打开的 nodeId（浮动工具按当前位置导出）。 */
  const [activeGuildNodeId, setActiveGuildNodeId] = useState<string | null>(null);
  const [dressUpSearchKind, setDressUpSearchKind] = useState<DressKind>('usage');
  const [dressUpEmojiTarget, setDressUpEmojiTarget] = useState<{
    packId: string;
    name: string;
    revision: string;
  } | null>(null);
  const [mailSearchTarget, setMailSearchTarget] = useState<
    (Extract<ContentSearchTarget, { kind: 'mailMessage' }> & { revision: string }) | null
  >(null);
  const [guildSearchTarget, setGuildSearchTarget] = useState<
    (Extract<ContentSearchTarget, { kind: 'guildMessage' }> & { revision: string }) | null
  >(null);
  const developmentDressTools = useDevelopmentDressTools();
  const [dressUpRequested, setDressUpOpen] = usePageState(
    'workspace:dress-up',
    false,
    pageValue.boolean,
  );
  const dressUpOpen = developmentDressTools && dressUpRequested;
  useEffect(() => {
    if (settingsOpen) setDressUpOpen(false);
  }, [settingsOpen, setDressUpOpen]);
  // 装扮样式注入提到这一层 —— 进主界面就生效,不必先打开装扮页。
  useDressSkin();
  const [albumDialog, setAlbumDialog] = useState<{
    groupCode: string;
    groupName: string;
    initialAlbumId?: string;
    searchRevision?: string;
  } | null>(null);
  const [groupFileDialog, setGroupFileDialog] = useState<{
    groupCode: string;
    groupName: string;
    initialFolderId?: string;
    initialFileId?: string;
    searchRevision?: string;
  } | null>(null);
  const [groupSidebarPopover, setGroupSidebarPopover] = useState<{
    kind: GroupSidebarFeature;
    groupCode: string;
    groupName: string;
    anchor: HTMLElement;
    ownerKey: string;
  } | null>(null);
  const toggleGroupSidebarPopover = useCallback(
    (
      kind: GroupSidebarFeature,
      conversation: Extract<Conversation, { type: 'group' }>,
      anchor: HTMLElement,
    ) => {
      setGroupSidebarPopover((current) =>
        current?.kind === kind &&
        current.groupCode === conversation.id &&
        current.ownerKey === messageScope
          ? null
          : {
              kind,
              groupCode: conversation.id,
              groupName: conversation.group.name,
              anchor,
              ownerKey: messageScope,
            },
      );
    },
    [messageScope],
  );
  const [groupWorkspaceLocation, setGroupWorkspaceLocation] = useState<{
    code: string;
    section?: import('../lib/profileNavigation').GroupWorkspaceTab;
    albumId?: string;
    folderId?: string;
    fileId?: string;
  } | null>(null);
  /** 群成员管理弹窗（改群昵称 / 踢人）：应用层持有，与群公告 / 群精华同层。 */
  const [groupMemberDialog, setGroupMemberDialog] = useState<
    | { kind: 'rename'; groupId: string; targetUid: string; name: string; initialCard: string }
    | { kind: 'kick'; groupId: string; targetUid: string; name: string }
    | null
  >(null);
  const [groupTitleDialog, setGroupTitleDialog] = useState<{
    groupCode: string;
    uid: string;
    name: string;
  } | null>(null);
  /** 防撤回面板（「更多 → 防撤回」）：弹窗，不是视图。 */
  /** 会话设置（头部顶栏的设置按钮）：群聊 / 私聊各一份。 */
  const [convSettings, setConvSettings] = useState<
    (ConversationSettingsRequest & { ownerKey: string }) | null
  >(null);
  useEffect(() => setConvSettings(null), [messageScope]);
  const openProfileConversationSettings = useCallback(
    (request: ConversationSettingsRequest) => {
      setConvSettings({ ...request, ownerKey: messageScope });
    },
    [messageScope],
  );
  const [remarkTarget, setRemarkTarget] = useState<RoamingTarget | null>(null);
  const [groupBugDialog, setGroupBugDialog] = useState<{
    groupCode: string;
    groupName: string;
  } | null>(null);
  // 「已退群成员」灯箱：与群公告 / 群精华同一层（应用层持有开关，数据只读本地
  // group_member3 64016=1，不碰协议）。
  const [groupLeftMembersDialog, setGroupLeftMembersDialog] = useState<{
    groupCode: string;
    groupName: string;
  } | null>(null);
  const [memberCard, setMemberCard] = useState<{
    member: User;
    anchor: { x: number; y: number };
    fromSpace?: boolean;
    /** 通知名片显式指定群上下文；null 表示好友通知，不继承当前聊天。 */
    groupContext?: { code: string; name: string } | null;
    /** 从关系图谱进来：带上共同群，资料卡的「聊天分析」才有群可分析。 */
    groupCode?: string;
    groupName?: string;
  } | null>(null);
  const [numberGroupCard, setNumberGroupCard] = useState<{
    accountUin: string | null;
    conversation: Extract<Conversation, { type: 'group' }>;
    anchor: HTMLElement | OverlayAnchor;
    detailsKnown?: boolean;
  } | null>(null);
  const [conversationIdentity, setConversationIdentity] = useState<{
    conversation: Extract<Conversation, { type: 'direct' }>;
    anchor: OverlayAnchor;
  } | null>(null);

  function openConversationProfile(conversation: ConcreteConversation, anchor: HTMLElement) {
    // 菜单点击后卸载；保留点击当时的位置，让名片仍在该处打开。
    const rect = anchor.getBoundingClientRect();
    setMemberCard(null);
    setNumberGroupCard(null);
    setConversationIdentity(null);
    if (conversation.type === 'group') {
      setNumberGroupCard({
        accountUin: openedUin,
        conversation,
        anchor: { element: anchor, rect },
      });
    } else if (
      conversation.generated ||
      readonlyConversationKind(conversation) ||
      isDatalineUid(conversation.id)
    ) {
      setConversationIdentity({ conversation, anchor: { element: anchor, rect } });
    } else {
      setMemberCard({
        member: conversation.otherUser,
        anchor: { x: rect.right, y: rect.top },
        groupContext: null,
      });
    }
  }

  const [editorState, setEditorState] = useState<{
    msgId: string;
    elements: RawElementWire;
  } | null>(null);
  const [addMessageConv, setAddMessageConv] = useState<Conversation | null>(null);
  // 合并转发：从聊天多选进入时带着一份草稿 + 会话成员候选；
  // 全局合成使用独立工作窗口，本地多选的合并转发仍复用原编辑器。
  const [mergeForwardDraft, setMergeForwardDraft] = useState<{
    draft: MfDraft;
    senderMode: 'conversation' | 'global';
    members: MfPerson[];
  } | null>(null);
  const compositionWindow = useCompositionWindow();
  const { open: openGroupResourceWindow, windows: groupResourceWindows } = useGroupResourceWindows({
    ownerKey: messageScope,
  });
  // 发出去但还没被 QQ 同步回来的合并转发（乐观渲染；不写库、不落缓存文件）。
  const [optimisticForwards, setOptimisticForwards] = useState<OptimisticForward[]>([]);
  const consumedForwardMessages = useRef(new Map<string, string>());
  useEffect(() => {
    consumedForwardMessages.current.clear();
  }, [messageScope]);
  // 同上，但发出去的是 Ark 卡片（推荐好友 / 推荐群 / 位置 / 图文 / 自定义 JSON）。
  const [optimisticArks, setOptimisticArks] = useState<OptimisticArk[]>([]);
  // 同上，但发出去的是普通消息（文本 / @ / 表情 / 图片 / 视频 / 语音 / 文件…）。
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessage[]>([]);
  const outgoingReceipt = useOutgoingReceipts(
    messageScope,
    optimisticMessages,
    optimisticArks,
    optimisticForwards,
    setOptimisticMessages,
    setOptimisticArks,
    setOptimisticForwards,
  );
  const outgoingConversationPreviews = useOutgoingConversationPreviews(
    messageScope,
    [optimisticMessages, optimisticArks, optimisticForwards],
    recentContactsData,
  );
  const outgoingQueue = useRef(new OutgoingQueue());
  useEffect(() => {
    return () => {
      outgoingQueue.current.clear();
    };
  }, [messageScope]);
  useEffect(() => {
    outgoingQueue.current.retain(new Set(optimisticMessages.map((item) => item.id)));
  }, [optimisticMessages]);
  /**
   * 当前通话的初始快照。非 null 就渲染通话窗口，窗口自己订阅后续状态并在
   * 结束后回调清空。只做主动发起 —— 来电由 QQ 本体处理，WeQ 收不到那条推送。
   */
  const [activeCall, setActiveCall] = useState<Parameters<typeof CallWindow>[0]['initial'] | null>(
    null,
  );
  const outgoingRecordsRef = useRef([optimisticMessages, optimisticArks, optimisticForwards]);
  outgoingRecordsRef.current = [optimisticMessages, optimisticArks, optimisticForwards];
  const outgoingAfterSeq = useCallback(
    (convId?: string) => {
      return captureOutgoingAfterSeq(
        convId,
        selectionRef.current,
        windowRef.current.anchored,
        loadedRef.current,
        outgoingRecordsRef.current,
      );
    },
    [selectionRef, windowRef, loadedRef],
  );
  // 失败占位与「可能未送达」占位共用同一套应用 + 刷新：都只清前端 state，不碰原库。
  const applyOutgoingRemoval = useCallback((remove: OutgoingRemoval) => {
    setOptimisticMessages(remove);
    setOptimisticArks(remove);
    setOptimisticForwards(remove);
  }, []);
  const refreshAfterRemoval = useCallback(
    async (conversations: ReadonlySet<string>) => {
      await Promise.all([
        utils.account.listRecentContacts.invalidate(),
        selectionRef.current && conversations.has(selectionRef.current.id)
          ? refreshWindow()
          : undefined,
      ]);
    },
    [utils, refreshWindow, selectionRef],
  );
  const dismissFailedOutgoing = useFailedOutgoingRemoval(applyOutgoingRemoval, refreshAfterRemoval);
  const dismissUnsentOutgoing = useDismissUnsentOutgoing(applyOutgoingRemoval, refreshAfterRemoval);
  const consumedFileMessages = useRef(new Set<string>());
  const consumedGeneratedMessages = useRef(new Map<string, string>());
  useEffect(() => {
    consumedGeneratedMessages.current.clear();
  }, [messageScope]);
  const gapFetchCursors = useRef(new Map<string, number>());
  const gapFetchQueue = useRef(Promise.resolve());
  const automaticGapAttempts = useRef(new Set<string>());
  /** 乐观条目持有的本地预览 blob（目前只有闪照）；条目被真消息收掉时释放。 */
  const optimisticBlobs = useRef(new Map<string, string>());
  /**
   * 本次会话里「已经成功拉过、但服务端那段 seq 本来就没有可渲染消息」的缺口。
   *
   * 缺口条完全由「相邻两条消息的 seq 差」算出来（`messageGapCount`），所以服务端
   * 返回空槽位 / 空消息时，即使拉取成功、没有报错，提示条也会一直挂着。把这类
   * 缺口记下来传给聊天窗，本次就不再显示（刷新会话 / 重开会话后重新判断）。
   *
   * key 用 `gap:前一条seq:后一条seq`，与多选里的缺口 id 同一套写法。
   */
  const [resolvedGaps, setResolvedGaps] = useState<Set<string>>(() => new Set());
  const [unplacedRoaming, setUnplacedRoaming] = useState<{
    conversation: Conversation;
    messages: MessageWire[];
  } | null>(null);
  // 当前会话的删除遮罩与隐藏标记；写入成功后更新，切换来源时清空。
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [hiddenDeletedIds, setHiddenDeletedIds] = useState<Set<string>>(new Set());
  const deletionRevision = useRef(0);

  const handleEditRaw = useCallback(async (message: Message) => {
    if (message.source === 'roaming') return;
    try {
      const result = await client.account.getRawElements.query({ msgId: message.id });
      if (result) {
        setEditorState({ msgId: message.id, elements: result.elements });
      }
    } catch (e) {
      console.error('[MainView] Failed to fetch raw elements:', e);
    }
  }, []);

  const handleSaveRaw = useCallback(
    async (elements: RawElementWire) => {
      if (!editorState) return;
      try {
        const success = await client.account.updateElements.mutate({
          msgId: editorState.msgId,
          elements,
        });
        if (success) {
          void refreshWindow();
        }
      } catch (e) {
        console.error('[MainView] Failed to update elements:', e);
        throw e;
      }
    },
    [editorState, refreshWindow],
  );

  /** kind + conversation key (peer uid / group code) used by the msg endpoints. */
  const convFetchKey = useCallback((c: Conversation): { kind: 'c2c' | 'group'; conv: string } => {
    if (c.type === 'group') return { kind: 'group', conv: c.group.identityValue };
    if (c.type === 'direct') return { kind: 'c2c', conv: c.otherUser.id };
    return { kind: 'c2c', conv: c.id }; // merged — should never actually be called
  }, []);

  type RecordCursor = NonNullable<
    Awaited<ReturnType<typeof client.account.messageHistoryPage.query>>['nextBefore']
  >;
  const readMessageRecords = useCallback(
    async (record: 'recalled' | 'deleted', conversation: Conversation, before?: RecordCursor) => {
      const binding = messageBindingRef.current;
      if (!binding) throw new Error('账号或数据源尚未就绪');
      const page = await client.account.messageHistoryPage.query({
        ...convFetchKey(conversation),
        ...binding,
        record,
        before,
      });
      return { ...page, rows: page.rows.map(toMessageWire) };
    },
    [convFetchKey, messageBindingRef],
  );
  const readRecalledMessages = useCallback(
    (conversation: Conversation, before?: RecordCursor) =>
      readMessageRecords('recalled', conversation, before),
    [readMessageRecords],
  );
  const readDeletedMessages = useCallback(
    (conversation: Conversation, before?: RecordCursor) =>
      readMessageRecords('deleted', conversation, before),
    [readMessageRecords],
  );
  const readRecordReplyMedia = useCallback(
    async (
      conversation: Conversation,
      rows: MessageWire[],
      origin: 'conversation' | 'settings',
    ) => {
      if (origin !== 'settings') return;
      const binding = messageBindingRef.current;
      const pending = new Map(rows.filter(needsReplyMedia).map((row) => [row.msgId, row]));
      if (!binding || !pending.size) return;
      const patches = await client.account.replyMedia.query({
        ...convFetchKey(conversation),
        ...binding,
        msgIds: [...pending.keys()],
      });
      return (current: MessageWire[]) => applyReplyMedia(current, pending, patches);
    },
    [convFetchKey, messageBindingRef],
  );
  const recalls = useConversationMessageRecords(
    messageScope,
    messageScopeRef,
    readRecalledMessages,
    readRecordReplyMedia,
  );
  const deletions = useConversationMessageRecords(
    messageScope,
    messageScopeRef,
    readDeletedMessages,
  );
  const { conversation: deletedConv, rows: deletedWires, loading: deletedLoading } = deletions;
  const { conversation: recalledConv, rows: recalledWires, loading: recalledLoading } = recalls;
  const closeConversationRecords = useCallback(() => {
    recalls.close('conversation');
    deletions.close();
  }, [recalls.close, deletions.close]);
  const closeSettingsRecalls = useCallback(() => recalls.close('settings'), [recalls.close]);
  useEffect(() => {
    if (!settingsOpen) closeSettingsRecalls();
  }, [settingsOpen, closeSettingsRecalls]);

  // QQ 原库保留 QQ 式删除；漫游消息只改 WeQ 的可恢复缓存标记。
  const handleDeleteMessage = useCallback(
    async (message: Message, conversation: Conversation, hidden = false) => {
      const pushToast = sourceToastPush(messageNotificationSource(conversation, message));
      if (messageBatchBlockReason(message, 'delete')) return;
      if (isLocalOutgoingMessage(message)) {
        dismissFailedOutgoing(message, conversation.id);
        return;
      }
      const { kind, conv } = convFetchKey(conversation);
      const scope = messageScopeRef.current;
      const binding = messageBindingRef.current;
      if (!scope || !binding) throw new Error('账号或数据源尚未就绪');
      deletionRevision.current += 1;
      try {
        const removed = await client.account.deleteMessage.mutate({
          msgId: message.id,
          kind,
          conv,
          hideAfterDelete: hidden,
          ...binding,
        });
        if (!removed) throw new Error('未找到可删除的消息记录');
        deletionRevision.current += 1;
        if (messageScopeRef.current !== scope || selectionRef.current?.id !== conversation.id)
          return;
        setDeletedIds((current) => new Set(current).add(message.id));
        setHiddenDeletedIds((current) => {
          const next = new Set(
            [...current].filter((id) => deletionIdentity(id) !== deletionIdentity(message.id)),
          );
          if (hidden) next.add(message.id);
          return next;
        });
      } catch (e) {
        console.error('[MainView] Failed to delete message:', e);
        pushToast({
          tone: 'error',
          title: '删除消息失败',
          detail: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    },
    [
      convFetchKey,
      dismissFailedOutgoing,
      pushToast,
      messageScopeRef,
      messageBindingRef,
      selectionRef,
    ],
  );

  const handleOpenGroupAlbums = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>) => {
      setGroupSidebarPopover(null);
      openGroupResourceWindow({
        kind: 'albums',
        groupCode: conversation.id,
        groupName: conversation.group.name,
      });
    },
    [openGroupResourceWindow],
  );

  const handleOpenGroupAnnouncements = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>, anchor: HTMLElement) => {
      toggleGroupSidebarPopover('announcements', conversation, anchor);
    },
    [toggleGroupSidebarPopover],
  );
  const handleOpenGroupSign = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>, anchor: HTMLElement) => {
      toggleGroupSidebarPopover('sign', conversation, anchor);
    },
    [toggleGroupSidebarPopover],
  );

  const handleOpenGroupEssence = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>, anchor: HTMLElement) => {
      toggleGroupSidebarPopover('essence', conversation, anchor);
    },
    [toggleGroupSidebarPopover],
  );

  // 群管理「修改群昵称」：从聊天页的头像菜单上报过来，弹窗 + 发包都在本层。
  const handleRenameGroupMember = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>, sender: User, targetUid: string) => {
      setGroupMemberDialog({
        kind: 'rename',
        groupId: conversation.group.id,
        targetUid,
        name: sender.displayName || sender.identityValue,
        initialCard: sender.displayName ?? '',
      });
    },
    [],
  );
  const handleChangeGroupMemberTitle = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>, sender: User, targetUid: string) => {
      if (conversation.group.role !== 'owner') return;
      setGroupTitleDialog({
        groupCode: conversation.group.identityValue,
        uid: targetUid,
        name: sender.displayName || sender.identityValue,
      });
    },
    [],
  );

  // 群管理「踢出群聊」：先二次确认，确认后再发包。
  const handleKickGroupMember = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>, sender: User, targetUid: string) => {
      setGroupMemberDialog({
        kind: 'kick',
        groupId: conversation.group.id,
        targetUid,
        name: sender.displayName || sender.identityValue,
      });
    },
    [],
  );

  function submitGroupMemberRename(card: string) {
    const target = groupMemberDialog;
    if (target?.kind !== 'rename') return;
    renameGroupMember.mutate(
      { groupId: target.groupId, targetUid: target.targetUid, card },
      {
        onSuccess: () => {
          pushToast({ tone: 'success', message: '群昵称已修改' });
          setGroupMemberDialog(null);
        },
        onError: (error) =>
          pushToast({
            tone: 'error',
            title: '修改群昵称失败',
            source: restoreNotificationSource(
              { ...target, initialCard: card },
              setGroupMemberDialog,
            ),
            detail: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  function submitGroupMemberKick() {
    const target = groupMemberDialog;
    if (target?.kind !== 'kick') return;
    kickGroupMember.mutate(
      { groupId: target.groupId, targetUid: target.targetUid },
      {
        onSuccess: () => {
          pushToast({ tone: 'success', message: '已将该成员移出群聊' });
          setGroupMemberDialog(null);
        },
        onError: (error) =>
          pushToast({
            tone: 'error',
            title: '踢出失败',
            source: restoreNotificationSource(target, setGroupMemberDialog),
            detail: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  const handleOpenConversationSettings = useCallback(
    (conversation: Extract<Conversation, { type: 'group' | 'direct' }>, anchor?: HTMLElement) => {
      const { kind, conv } = convFetchKey(conversation);
      const title =
        conversation.type === 'group'
          ? conversation.group.name
          : conversation.otherUser.displayName;
      // 数据线（我的手机/我的电脑）在消息库里是独立的 dataline_msg_table，触发器
      // 也要按 'dataline' 装，否则它和私聊会用错表。
      const dataline =
        conversation.type === 'direct' &&
        conversation.chatType !== undefined &&
        isDataline(conversation.chatType);
      setConvSettings({
        kind: kind === 'group' ? 'group' : dataline ? 'dataline' : 'c2c',
        conv,
        title,
        anchor,
        ownerKey: messageScope,
        ...(conversation.type === 'group' ? { groupConversation: conversation } : {}),
      });
    },
    [convFetchKey, messageScope],
  );

  const handleOpenGroupLeftMembers = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>) => {
      setGroupLeftMembersDialog({
        groupCode: conversation.group.identityValue,
        groupName: conversation.group.name,
      });
    },
    [],
  );

  const handleOpenGroupBug = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>) => {
      setGroupBugDialog({
        groupCode: conversation.id,
        groupName: conversation.group.name,
      });
    },
    [],
  );

  const handleAddMessage = useCallback((conversation: Conversation) => {
    setAddMessageConv(conversation);
  }, []);

  const handleViewDeleted = useCallback(
    (conversation: Conversation) => {
      recalls.close('conversation');
      void deletions.open(conversation);
    },
    [recalls.close, deletions.open],
  );

  const handleViewRecalled = useCallback(
    (conversation: Conversation) => {
      deletions.close();
      void recalls.open(conversation);
    },
    [deletions.close, recalls.open],
  );

  const handleOpenGapMessages = useCallback(
    async (
      gap: {
        conversation: Conversation;
        previousSeq: string;
        currentSeq: string;
        count: number;
      },
      automatic = false,
    ) => {
      const selection = selectionRef.current;
      const win = windowRef.current;
      const scope = messageScopeRef.current;
      const binding = messageBindingRef.current;
      const { kind, conv } = convFetchKey(gap.conversation);
      const key = [kind, conv, gap.previousSeq, gap.currentSeq].join(':');
      const first = Number(BigInt(gap.previousSeq) + 1n);
      const end = Number(BigInt(gap.currentSeq) - 1n);
      const previous = gapFetchQueue.current;
      let release!: () => void;
      gapFetchQueue.current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const current = () =>
        selectionRef.current === selection &&
        windowRef.current === win &&
        messageScopeRef.current === scope &&
        selection?.id === gap.conversation.id &&
        (!automatic ||
          (preferenceValue('autoFetchMissingMessages') &&
            messagesTabActiveRef.current &&
            document.visibilityState !== 'hidden'));
      const notify = (toast: Parameters<typeof pushToast>[0]) => {
        if (!automatic)
          pushToast({ ...toast, source: conversationNotificationSource(gap.conversation) });
      };
      await previous;
      try {
        if (!binding || !scope || !current()) return;
        let start = gapFetchCursors.current.get(key) ?? first;
        if (automatic) {
          if (automaticGapAttempts.current.has(key)) return;
          automaticGapAttempts.current.add(key);
          if (automaticGapAttempts.current.size > 500)
            automaticGapAttempts.current.delete(
              automaticGapAttempts.current.values().next().value!,
            );
        }
        // Bound each click to eight empty windows; unresolved gaps remain visible.
        for (let page = 0; page < 8; page += 1) {
          if (!current()) return;
          const result = await client.account.fetchGapMessages.query({
            ...binding,
            kind,
            conv,
            startSeq: start,
            endSeq: end,
          });
          if (!current()) return;
          if (!result.ok) {
            notify({ tone: 'warning', message: result.message });
            return;
          }
          if (result.nextStartSeq !== null) gapFetchCursors.current.set(key, result.nextStartSeq);
          else gapFetchCursors.current.delete(key);
          const rows = result.messages.filter(
            (row) =>
              (kind === 'group' || row.ntSeqVerified === true) &&
              BigInt(row.msgSeq) >= BigInt(first) &&
              BigInt(row.msgSeq) <= BigInt(end),
          );
          if (rows.length > 0) {
            setLoaded((current) =>
              mergeRoamingTimeline(
                kind,
                current,
                rows.map((row) => ({
                  ...toMessageWire(row),
                  source: 'roaming' as const,
                })),
              ),
            );
            return;
          }
          if (result.messages.length > 0) {
            if (!automatic)
              setUnplacedRoaming({
                conversation: gap.conversation,
                messages: result.messages.map((row) => ({
                  ...toMessageWire(row),
                  source: 'roaming' as const,
                })),
              });
            notify({
              tone: 'warning',
              message: '这些私聊漫游记录缺少已确认的 NT 序号，暂不能安全混排。',
            });
            return;
          }
          if (result.nextStartSeq === null) {
            // 整段窗口都拉完了、没有报错，却一条可渲染的消息都没有 —— 服务端那段
            // seq 本来就没有消息（空槽位 / 已过期 / 未开漫游）。缺口条是按 seq 差
            // 算的，不记一笔就会一直挂着，所以本次把它收起来。
            setResolvedGaps((current) => {
              const next = new Set(current);
              next.add(`gap:${gap.previousSeq}:${gap.currentSeq}`);
              return next;
            });
            notify({
              tone: 'info',
              durationKind: 'success',
              message: '该缺口未拉取到可用记录，消息可能已过期或未开启漫游。',
            });
            return;
          }
          start = result.nextStartSeq;
        }
        notify({
          tone: 'info',
          durationKind: 'success',
          message: '已检查 240 个消息序号，暂未找到记录；可再次点击继续。',
        });
      } catch (error) {
        notify({
          tone: 'error',
          title: '拉取缺失消息失败',
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        release();
        if (gapFetchCursors.current.size > 100)
          gapFetchCursors.current.delete(gapFetchCursors.current.keys().next().value!);
      }
    },
    [
      convFetchKey,
      pushToast,
      setLoaded,
      selectionRef,
      windowRef,
      messageScopeRef,
      messageBindingRef,
    ],
  );

  const handleRestoreMessage = useCallback(
    async (msgId: string, conversation?: Conversation | null): Promise<void> => {
      const scope = messageScopeRef.current;
      const binding = messageBindingRef.current;
      if (!scope || !binding) throw new Error('账号或数据源尚未就绪');
      deletionRevision.current += 1;
      const restored = await client.account.restoreMessage.mutate({
        msgId,
        ...binding,
        ...(msgId.startsWith('roaming:') && conversation ? convFetchKey(conversation) : {}),
      });
      if (!restored) throw new Error('未找到可恢复的消息记录');
      deletionRevision.current += 1;
      if (messageScopeRef.current !== scope) return;
      // Clear the in-place overlay for the restored message.
      if (!conversation || selectionRef.current?.id === conversation.id) {
        setDeletedIds((current) => {
          return new Set(
            [...current].filter((id) => deletionIdentity(id) !== deletionIdentity(msgId)),
          );
        });
        setHiddenDeletedIds((current) => {
          return new Set(
            [...current].filter((id) => deletionIdentity(id) !== deletionIdentity(msgId)),
          );
        });
      }
      const conversationId = conversation?.id ?? selectionRef.current?.id;
      if (conversationId) {
        const identity = deletionIdentity(msgId);
        deletions.removeRows(
          conversationId,
          (row) => deletionIdentity(timelineRowKey(row)) === identity,
        );
      }
      void refreshWindow();
    },
    [
      deletions.removeRows,
      refreshWindow,
      convFetchKey,
      messageScopeRef,
      messageBindingRef,
      selectionRef,
    ],
  );

  const handleOpenGroupMember = useCallback((member: User, anchor: { x: number; y: number }) => {
    setMemberCard({ member, anchor });
  }, []);

  // 聊天顶栏「搜索聊天记录」：把当前会话固化为搜索目标，打开单会话版聊天记录模态。
  const handleSearchChatRecords = useCallback((conversation: Conversation) => {
    if (conversation.type === 'group') {
      const code = conversation.group.id;
      setChatRecordsTarget({
        hit: {
          category: 'chatRecord',
          source: 'group',
          partition: code,
          targetUid: code,
          targetUin: '0',
          name: conversation.group.name || code,
          count: 0,
        },
        keyword: '',
        fixed: true,
      });
      return;
    }
    if (conversation.type === 'direct') {
      const { otherUser } = conversation;
      const uin = otherUser.username || otherUser.identityValue || '';
      setChatRecordsTarget({
        hit: {
          category: 'chatRecord',
          source: 'buddy',
          partition: otherUser.id,
          targetUid: otherUser.id,
          targetUin: uin,
          name: otherUser.displayName || uin || otherUser.id,
          count: 0,
        },
        keyword: '',
        fixed: true,
      });
    }
  }, []);

  const handleAnalyzeConversation = useCallback((conversation: Conversation) => {
    const target = conversationAnalysisTarget(conversation);
    if (target)
      setAnalysisRequest((previous) => ({ target, revision: (previous?.revision ?? 0) + 1 }));
  }, []);
  const handleRoamingTargets = useCallback((targets: RoamingTarget[]) => {
    if (targets.length)
      setRoamingRequest((previous) => ({
        targets: targets.map((target) => ({ ...target })),
        revision: (previous?.revision ?? 0) + 1,
      }));
  }, []);

  const onlineStatusByUid = useContactOnlineStatuses(buddies.data, contactsPageOpen);
  // Unread count per conversation id (latest msgSeq - last read seq). Filled
  // asynchronously after the recent-contact list loads / refreshes.
  const [unreadByConv, setUnreadByConv] = useState<Record<string, number>>({});
  const unreadUpdateGuardRef = useRef(createUnreadUpdateGuard());
  const unreadRefreshStateRef = useRef(createUnreadRefreshState());
  const manualReadPendingRef = useRef(new Set<string>());
  const [readStateBusy, setReadStateBusy] = useState(false);
  const readStateBusyRef = useRef(false);
  const [readUndo, setReadUndo] = useState<{
    accountUin: string;
    token: string;
    ids: string[];
    action: 'mark-read' | 'mark-unread';
  } | null>(null);
  const readUndoRef = useRef(readUndo);
  readUndoRef.current = readUndo;
  const [highlightsByConv, setHighlightsByConv] = useState<Record<string, ConversationHighlight[]>>(
    {},
  );
  // 分页更新时为历史发言人保留名片快照，不将已退群成员重新加入当前名单。
  const [senderMemberPages, setSenderMemberPages] = useState<Record<string, GroupMemberWire[]>>({});
  const [groupInfoRevision, setGroupInfoRevision] = useState(0);
  // Off-page message senders resolved on demand (groupCode → uid → member),
  // batched + deduped by useGroupMemberResolver. Kept separate from the global
  // profile cache because a group card is a (group × uid) thing, not a profile.
  const groupMemberLookup = useMemo(() => {
    const binding = messageScope ? messageBindingRef.current : null;
    return createGroupMemberLookup<GroupMemberWire>((input) =>
      client.account.getGroupMembersByUids.query({ ...binding, ...input }),
    );
  }, [messageScope, messageBindingRef]);
  const {
    missingMembers,
    resolveMembers,
    updateMembers: updateCachedMembers,
    invalidate: invalidateCachedMembers,
  } = useGroupMemberResolver<GroupMemberWire>(0, groupMemberLookup.load);
  const {
    missingMembers: previewMembers,
    resolveMembers: resolvePreviewMembers,
    updateMembers: updatePreviewMembers,
    invalidate: invalidatePreviewMembers,
  } = useGroupMemberResolver<GroupMemberWire>(
    GROUP_MEMBER_PREVIEW_REFRESH_MS,
    groupMemberLookup.load,
  );
  const [analysisReports, setAnalysisReports] = useState<AnalysisReportRequest[]>([]);
  useEffect(() => {
    const open = (event: Event) => {
      const id: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof id !== 'string') return;
      const expected = useViewState.getState().openedUin;
      void client.account.getAccountConfig
        .query()
        .then(async (config) => {
          if (!config || config.uin !== expected || expected !== useViewState.getState().openedUin)
            return;
          const saved = await client.account.analysisReports.get.query({
            id,
            expectedAccountUin: config.uin,
            expectedAccountConfigId: config.configId,
          });
          if (expected !== useViewState.getState().openedUin) return;
          const request = restoredAnalysisRequest(saved.request);
          if (request)
            setAnalysisReports((previous) => [
              ...previous.filter((report) => report.id !== request.id),
              request,
            ]);
        })
        .catch((error: unknown) => console.error('[analysis-reports] 无法打开报告', error));
    };
    window.addEventListener('weq:open-saved-analysis', open);
    return () => window.removeEventListener('weq:open-saved-analysis', open);
  }, []);
  const [analysisRequest, setAnalysisRequest] = useState<AnalysisToolRequest | null>(null);
  const [roamingRequest, setRoamingRequest] = useState<{
    targets: RoamingTarget[];
    revision: number;
  } | null>(null);
  const [cloneSearchTarget, setCloneSearchTarget] = useState<GeneratedSearchHit | null>(null);
  const [collectionSearchTarget, setCollectionSearchTarget] = useState<{
    cid: string;
    revision: number;
  } | null>(null);
  const [assistantSearchTarget, setAssistantSearchTarget] = useState<GeneratedSearchHit | null>(
    null,
  );
  // Temporary dismiss of the search dropdown — clicking outside it hides it
  // so the user can reach contact/group results underneath. Clicking the
  // search box or typing a new query restores the dropdown.
  const [searchDismissed, setSearchDismissed] = useState(false);
  // 搜索框点开但尚未输入时，仅显示范围选择。
  const [searchFocused, setSearchFocused] = useState(false);
  // Set when a search hit was clicked: the listLatest effect, after the target
  // conversation's newest page lands, rebuilds the window centred on this seq
  // instead of leaving the view pinned to the latest.
  const [chatRecordsTarget, setChatRecordsTarget] = useState<{
    hit: ChatRecordSearchHit;
    keyword: string;
    /** 顶栏搜索按钮进入：固定在该会话内搜索（隐藏左侧会话列表）。 */
    fixed?: boolean;
  } | null>(null);

  // 统一的 profile 内存缓存：listProfiles 预热 + 缺失项按需批量补全，所有消费方
  // （好友列表 / 通知 / 搜索）共用这一个 Map。补全在下方的解析 effect 触发。
  const [restoredProfiles] = useState(() =>
    IS_WEB ? (queryClient.getQueryData<UserProfileWire[]>(resolvedProfilesKey) ?? []) : [],
  );
  const {
    profileByUid,
    resolveProfiles,
    refreshProfiles: refreshProfileCache,
  } = useProfileResolver<UserProfileWire>(profiles.data, restoredProfiles);
  useEffect(() => {
    if (IS_WEB && profileByUid.size)
      queryClient.setQueryData(resolvedProfilesKey, [...profileByUid.values()]);
  }, [queryClient, profileByUid]);
  const previewDisplayNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const profile of profileByUid.values()) {
      const name = profile.remark || profile.nick;
      if (!name) continue;
      names.set(profile.uid, name);
      if (profile.uin && profile.uin !== '0') names.set(profile.uin, name);
    }
    return names;
  }, [profileByUid]);
  const previewGroupNames = useMemo(() => {
    const groups = new Map<string, ReadonlyMap<string, string>>();
    for (const [code, members] of Object.entries(previewMembers)) {
      const names = new Map<string, string>();
      for (const member of Object.values(members)) {
        const profile = profileByUid.get(member.uid);
        const name = displayGroupMemberName(
          member.card,
          profile?.remark,
          member.nick || profile?.nick,
          member.uin || member.uid,
        );
        if (!name) continue;
        names.set(member.uid, name);
        if (member.uin && member.uin !== '0') names.set(member.uin, name);
      }
      groups.set(code, names);
    }
    return groups;
  }, [previewMembers, profileByUid]);
  const {
    categoryById,
    botUids,
    buddyContacts,
    relationshipDirectory,
    setVisibleGroupNames,
    attemptedGroupNames,
    groupNameByCode,
    hiddenUidSet,
    deletedUidSet,
    hiddenConversationsById,
    deletedConversationsById,
    conversations,
    sidebarConversations,
    specialContactSections,
    historicalContactSections,
    contactDirectoryConversations,
    profileContacts,
    contactRequests,
    groupRequests,
  } = useWorkspaceDirectory({
    user,
    profileByUid,
    previewDisplayNames,
    previewGroupNames,
    recentContactsData,
    categories,
    botUidList,
    buddies,
    allGroups,
    topContacts,
    hiddenSessions,
    deletedSessions,
    officialAccounts,
    serviceAccounts,
    guildDirectSessions,
    buddyRequests,
    groupNotifies,
    onlineStatusByUid,
    specialCare,
    specialCareUnavailable,
    groupAssistantEntry,
    groupAssistantIds,
    temporaryConversations,
    outgoingConversationPreviews,
    unreadByConv,
    highlightsByConv,
    draftTimesByConv,
  });
  /**
   * 关系图谱（群友圈子 / 重合图 / 排行榜）里点某个人：复用聊天里的资料卡。
   * 能在好友列表里对上号就带上联系人对象（有备注 / 分组 / 亲密关系），否则用
   * uid + uin 拼一个最小 User —— 卡片自己会去 profile_info_v6 补全其余字段。
   */
  const handleOpenGraphMember = useCallback(
    (
      node: { uid: string; uin: string; nick?: string; card?: string },
      anchor: { x: number; y: number },
      group?: { code: string; name: string },
    ) => {
      if (!node?.uid) return;
      const contact = buddyContacts.find(
        (person) => person.id === node.uid || (!!node.uin && person.identityValue === node.uin),
      );
      const profile = profileByUid.get(node.uid);
      setMemberCard({
        member: contact ?? {
          id: node.uid,
          identityLabel: 'QQ',
          identityValue: node.uin || profile?.uin || '',
          username: node.uid,
          displayName: node.card || node.nick || profile?.nick || node.uin || node.uid,
          avatarUrl: node.uin ? senderAvatarSrc(node.uin) : null,
        },
        anchor,
        fromSpace: true,
        groupCode: group?.code,
        groupName: group?.name,
      });
    },
    [buddyContacts, profileByUid],
  );
  const noticeConfig = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: Boolean(openedUin),
    refetchOnMount: false,
  });
  const noticeAccountKey =
    noticeConfig.data?.uin === openedUin ? `${openedUin}:${noticeConfig.data.configId}` : '';
  const essenceReceipts = useQQEssence((state) => state.receipts);
  const essenceSourceKey = essenceSource(
    noticeConfig.data?.uin === openedUin
      ? {
          expectedAccountUin: openedUin,
          expectedAccountConfigId: noticeConfig.data.configId,
        }
      : null,
  );
  const shellHistory = useMemo(
    () => ({
      isMobileShell,
      // 首次进入消息页不自动选中会话；后续切回保留用户已经选中的会话。
      shouldAutoSelectConversation: () => false,
      replaceShell: () => undefined,
      pushShellDetail: () => undefined,
      pushConversationDetail: () => undefined,
    }),
    [],
  );
  const shell = useChatShellController({
    conversations: contactDirectoryConversations,
    contacts: profileContacts,
    initialActiveConversationId: null,
    // 手机直接落在消息列表；桌面保留主页，会话均由用户显式点选。
    initialView: IS_WEB && isMobileShell() ? 'messages' : 'home',
    startupView,
    sidebarWidthStorageKey: 'weq.desktop.sidebarWidth.v2',
    history: shellHistory,
  });

  const { drafts, updateDraft, syncDraftsFromPending, flushAllDirtyDrafts } = useWorkspaceDrafts({
    binding: pinSession.binding,
    messageScope,
    openedUin,
    activeConversationId: shell.activeConversationId,
    resolveConversation: (id) =>
      conversations.find((row) => row.id === id) ??
      hiddenConversationsById.get(id) ??
      deletedConversationsById.get(id),
  });
  useEffect(() => {
    setContactsPageOpen(shell.view === 'contacts');
  }, [shell.view]);
  const detailContact = shell.view === 'contacts' ? shell.selectedContact : undefined;
  const { uid: detailContactUid, uin: detailContactUin } = contactProfileIdentity(detailContact);
  const cachedContactProfile =
    profileByUid.get(detailContactUid) ??
    (detailContactUin
      ? [...profileByUid.values()].find((profile) => profile.uin === detailContactUin)
      : undefined);
  const detailContactProfile = trpc.account.getProfile.useQuery(
    { uid: detailContactUid },
    {
      enabled: Boolean(detailContactUid) && !cachedContactProfile,
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
  const detailContactProfileByUin = trpc.account.getProfileByUin.useQuery(
    { uin: detailContactUin },
    {
      enabled:
        !detailContactUid && /^[1-9]\d{4,19}$/.test(detailContactUin) && !cachedContactProfile,
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
  const selectedContactForDetail = useMemo(() => {
    if (!detailContact) return undefined;
    if (!detailContactUid && !detailContactUin) return detailContact;
    const profile =
      cachedContactProfile ?? detailContactProfile.data ?? detailContactProfileByUin.data;
    if (!profile) return detailContact;
    const resolved = buddyToContact(
      {
        uid: profile.uid,
        uin: profile.uin || detailContactUin,
        qid: profile.qid,
        categoryId: detailContact.categoryId ?? -1,
      },
      new Map([[profile.uid, profile]]),
      categoryById,
      botUids,
    );
    return {
      ...detailContact,
      ...resolved,
      createdAt: detailContact.createdAt,
      categoryId: detailContact.categoryId,
      categoryName: detailContact.categoryName,
      avatarUrl: resolved.avatarUrl || detailContact.avatarUrl,
      onlineStatus: detailContact.onlineStatus || resolved.onlineStatus,
      kind: detailContact.kind || resolved.kind,
    };
  }, [
    detailContact,
    detailContactUid,
    cachedContactProfile,
    detailContactProfile.data,
    detailContactProfileByUin.data,
    detailContactUin,
    categoryById,
    botUids,
  ]);
  const friendNoticeIds = useMemo(() => contactRequests.map((r) => r.id), [contactRequests]);
  const groupNoticeIds = useMemo(() => groupRequests.map((r) => r.id), [groupRequests]);
  const openFriendNotice = useStableCallback(() => shell.openContactNotice('friend'));
  const openGroupNotice = useStableCallback(() => shell.openContactNotice('group'));
  const friendNoticeCount = useAccountNoticeUnread(
    noticeAccountKey,
    'friend',
    friendNoticeIds,
    shell.contactNotice === 'friend',
    buddyRequests.isSuccess,
    { title: '收到新的好友通知', onOpen: openFriendNotice },
  );
  const groupNoticeCount = useAccountNoticeUnread(
    noticeAccountKey,
    'group',
    groupNoticeIds,
    shell.contactNotice === 'group',
    groupNotifies.isSuccess,
    { title: '收到新的群通知', onOpen: openGroupNotice },
  );
  const mailOpenRef = useRef(shell.switchView);
  mailOpenRef.current = shell.switchView;
  const openMailView = useCallback(() => mailOpenRef.current('mail'), []);

  // shell.activeConversation 只在主 conversations 列表里查找；隐藏会话和删除会话
  // 故意不进那份列表（见上方 conversations useMemo），所以查不到时兜底查
  // hiddenConversationsById 和 deletedConversationsById —— 否则从选择器点进去，消息页面直接打不开。
  const handleOpenGroupInfoDetail = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>, detail: GroupInfoDetail) => {
      setGroupWorkspaceLocation({
        code: conversation.id,
        section: detail === 'albums' ? 'albums' : 'details',
      });
      shell.openGroupDetails(conversation);
    },
    [shell.openGroupDetails],
  );
  const selectedConversation =
    shell.activeConversation ??
    (shell.activeConversationId
      ? hiddenConversationsById.get(shell.activeConversationId)
      : undefined) ??
    (shell.activeConversationId
      ? deletedConversationsById.get(shell.activeConversationId)
      : undefined);
  const selectedUid = selectedConversation?.id ?? '';
  const selectedUidRef = useRef(selectedUid);
  selectedUidRef.current = selectedUid;
  const messagesTabActive = shell.view === 'messages' && !arkFeedState && !specialChat;
  useEffect(() => {
    if (!messagesTabActive || (deletedConv && deletedConv.id !== selectedUid)) deletions.close();
    if (!messagesTabActive || (recalledConv && recalledConv.id !== selectedUid))
      recalls.close('conversation');
  }, [messagesTabActive, selectedUid, deletedConv, recalledConv, deletions.close, recalls.close]);
  useEffect(() => {
    setGroupSidebarPopover((current) =>
      current &&
      (current.groupCode !== selectedUid || current.ownerKey !== messageScope || !messagesTabActive)
        ? null
        : current,
    );
  }, [selectedUid, messageScope, messagesTabActive]);
  const activeGroupSidebarPopover =
    groupSidebarPopover?.groupCode === selectedUid &&
    groupSidebarPopover.ownerKey === messageScope &&
    messagesTabActive
      ? groupSidebarPopover
      : null;
  const announcementsDialog =
    activeGroupSidebarPopover?.kind === 'announcements' ? activeGroupSidebarPopover : null;
  const groupSignDialog =
    activeGroupSidebarPopover?.kind === 'sign' ? activeGroupSidebarPopover : null;
  const essenceDialog =
    activeGroupSidebarPopover?.kind === 'essence' ? activeGroupSidebarPopover : null;
  const resolveNoticeGroupSenderName = useCallback(
    async (message: IncomingMessageWire) => {
      const names = previewGroupNames.get(message.conv);
      const cached = names?.get(message.senderUid) || names?.get(message.senderUin);
      if (cached) return cached;
      const binding = messageBindingRef.current;
      const profile = profileByUid.get(message.senderUid);
      const profileName =
        previewDisplayNames.get(message.senderUid) || previewDisplayNames.get(message.senderUin);
      if (!binding || (!message.senderUid && !/^[1-9]\d*$/.test(message.senderUin)))
        return profileName || '';
      const members = await (message.senderUid
        ? groupMemberLookup.load({
            groupCode: message.conv,
            uids: [message.senderUid],
          })
        : client.account.getGroupMembersByUins.query({
            ...binding,
            groupCode: message.conv,
            uins: [message.senderUin],
          })
      ).catch(() => []);
      const member = members[0];
      return displayGroupMemberName(
        member?.card,
        profile?.remark,
        member?.nick || profile?.nick,
        profileName || '',
      );
    },
    [previewGroupNames, previewDisplayNames, profileByUid, messageBindingRef, groupMemberLookup],
  );
  const messagesTabActiveRef = useRef(messagesTabActive);
  messagesTabActiveRef.current = messagesTabActive;
  const isGroup = selectedConversation?.type === 'group';
  const isDirect = selectedConversation?.type === 'direct';
  const selectedMessageWindowKey = conversationWindowKey(
    messageScope,
    isGroup ? 'group' : 'c2c',
    selectedUid,
  );
  useEffect(() => {
    if (IS_WEB && !firstPageStreamReady) firstPages.interrupt();
    const key =
      selectedUid && (isDirect || isGroup)
        ? firstPageKey({ kind: isGroup ? 'group' : 'c2c', conv: selectedUid, limit: 0 })
        : '';
    firstPages.activate(
      Boolean(
        messageScope &&
          displaySettings.isSuccess &&
          messagesTabActive &&
          messageActivity.enabled &&
          (!IS_WEB || firstPageStreamReady) &&
          !displaySettings.data?.readFromFirstUnread,
      ),
      key,
    );
  }, [
    firstPages,
    firstPageStreamReady,
    selectedUid,
    isDirect,
    isGroup,
    messagesTabActive,
    messageActivity.enabled,
    messageScope,
    displaySettings.data?.readFromFirstUnread,
    displaySettings.isSuccess,
  ]);

  /* ── 合并转发（合成聊天记录）────────────────────────────────────────────
   *
   * 真正发包的接缝是 forwardMergeDraft —— 合并转发的协议（UploadLongMsg）
   * 由另一分支接入，这里只把参数（SnowLuma 的 ForwardNodePayload 那一套：
   * userUin / nickname / elements / time / decoration）准备好。 */
  const mergeForwardSelf: MfPerson = useMemo(
    () => ({
      uid: selfProfile.data?.uid ?? '',
      uin: user.identityValue,
      name: user.displayName,
    }),
    [selfProfile.data?.uid, user],
  );

  /** 可转发到的会话沿用列表顺序，不按好友／群聊分组；合并会话入口不可转发。 */
  const mergeForwardTargets: MfTarget[] = useMemo(
    () =>
      conversations
        .filter(
          (c): c is Extract<Conversation, { type: 'group' | 'direct' }> =>
            c.type === 'group' || c.type === 'direct',
        )
        .map((c) =>
          c.type === 'group'
            ? {
                id: c.id,
                kind: 'group' as const,
                conv: c.group.identityValue,
                name: c.group.name,
                avatarUrl: c.group.avatarUrl,
                groupAssistant: groupAssistantIds.has(c.id),
              }
            : {
                id: c.id,
                kind: 'c2c' as const,
                // 发送目标优先用 QQ 号（发送侧按 uin 查 uid 更稳），没拿到才退回 uid。
                conv: c.otherUser.identityValue || c.otherUser.id,
                name: c.otherUser.displayName,
                avatarUrl: c.otherUser.avatarUrl,
              },
        ),
    [conversations, groupAssistantIds],
  );

  const mergeForwardSendAvailable = sendAvailable;

  /** 会话成员（发送人候选；群 → 全部成员，私聊 → 对方）。 */
  const mergeForwardMembersOf = useCallback((c: Conversation): MfPerson[] => {
    if (c.type === 'group') {
      return c.members.map((m) => ({ uid: m.id, uin: m.identityValue, name: m.displayName }));
    }
    if (c.type === 'direct') {
      return [
        { uid: c.otherUser.id, uin: c.otherUser.identityValue, name: c.otherUser.displayName },
      ];
    }
    return [];
  }, []);

  /**
   * 给「本机 `nt_data` 里有缓存、但 40800 元素里没写路径」的媒体补上 `localPath`。
   *
   * 收到的图片 / 语音 / 视频 / 文件通常**不带** `localPath`(45004)（那个 tag 基本只
   * 在 QQ 自己发出 / 草稿里出现），但缓存文件是有的。不补的话导入后会被降级成
   * `[图片]` 文本（见 codecElementToSeg），转发出去就真的只剩一行文字。按
   * (发送时间, 文件名) 走主进程的 FileSearchService 找文件（与 `weq-media://pic`
   * 同一条链路），找不到就保持原样。
   */
  const hydrateMergeForwardMedia = useCallback(
    async (elements: unknown[], sendTimeMs: number): Promise<void> => {
      const text = (value: unknown): string => (typeof value === 'string' ? value : '');
      await Promise.all(
        elements.map(async (raw) => {
          if (!raw || typeof raw !== 'object') return;
          const el = raw as Record<string, unknown>;
          const kind = text(el.kind);
          if (kind !== 'pic' && kind !== 'ptt' && kind !== 'video' && kind !== 'file') return;
          // 元素自带路径 = 发得出去，不用找（口径与 codecElementToSeg 一致）。
          // 剥掉 `::NTOSFull::` 虚拟前缀再判断 —— 带前缀的「路径」不是真文件，
          // 当成 existing 会既找不到缓存、又在发送时 ENOENT。
          const existing = cleanNtPath(
            kind === 'pic'
              ? text(el.localPath) || text(el.filePath)
              : kind === 'ptt'
                ? text(el.filePath)
                : kind === 'video'
                  ? text(el.filePath) || text(el.videoCoverLocalPath) || text(el.fileThumbLocalPath)
                  : text(el.filePath),
          );
          if (existing) return;
          const name = text(el.fileName).trim();
          if (!name) return;
          const type = kind === 'pic' ? (Number(el.subType) === 1 ? 'emoji' : 'pic') : kind;
          try {
            const hit = await client.account.mediaResource.findLocalFile.query({
              t: sendTimeMs,
              name,
              kind: type,
            });
            // 图片（含自定义表情）读 localPath；语音 / 视频 / 文件读 filePath —— 两个
            // 都写上，卖导入函数不必再关心哪种媒体读哪个字段。
            const found = hit.source ?? (type === 'emoji' ? hit.thumb : null);
            if (found) {
              el.localPath = found;
              el.filePath = found;
            }
          } catch {
            /* 找不到就保持原样（仍会退化成文本） */
          }
        }),
      );
    },
    [client],
  );

  /**
   * 多选的消息 → 一份草稿。
   *
   * 关键：**回读每条消息的原始 wire 元素**（`account.getRawElements`）而不是只有
   * 渲染元素 —— 图片 / 语音这类媒体要从原始元素里拿本机缓存路径，发送时才能真实
   * 上传；拿不到（或离线）时退化为渲染元素派生的分段（媒体落成文本标签）。
   */
  const buildMergeForwardDraft = useCallback(
    async (
      messages: Message[],
      downloadImages?: NonNullable<typeof pinSession.binding>,
    ): Promise<MfDraft> => {
      const now = Math.floor(Date.now() / 1000);
      const nodes: MfNode[] = [];
      for (const message of messages) {
        const sender = message.sender;
        const senderInfo = {
          uid: sender?.id ?? message.senderId,
          uin: sender?.identityValue ?? '',
          name: sender?.displayName || sender?.identityValue || '未知用户',
        };
        const msgId = (message as { msgId?: string }).msgId ?? message.id;
        const parsed = Date.parse(message.createdAt);
        const sendTimeMs = Number.isFinite(parsed)
          ? parsed
          : message.forwardSnapshot
            ? 0
            : now * 1000;
        let segs: MfSeg[] = [];
        // 渲染视图元素与原始元素是**同一条 40800 列按顺序解出来的**，按下标一一对应。
        // 交给导入函数后，「本机没有缓存文件的图片 / 视频 / 文件 / 语音」也能导成能画出
        // 真卡片的 opaque 段，而不是一段 `[文件: x]` 文本。
        const renderElements = ((message as { qqElements?: MfElement[] }).qqElements ??
          []) as MfElement[];
        if (message.forwardSnapshot) {
          const snapshot = renderElements.map((element) => ({
            ...element.data,
            kind: element.type,
            ...(element.type === 'mface'
              ? { marketEmoticonId: element.data?.marketEmoticonIdHex }
              : {}),
          }));
          await hydrateMergeForwardMedia(snapshot, sendTimeMs);
          if (downloadImages) {
            // 没有本地路径或完整指纹的图片，继续走普通逐条转发的取图链路。
            for (const [index, raw] of snapshot.entries()) {
              const element = renderElements[index];
              if (!element || raw.kind !== 'pic' || codecElementToSeg(raw, element)?.t !== 'opaque')
                continue;
              try {
                const bytes = (await repeatImageSources([element], sendTimeMs)).get(element);
                if (!bytes) continue;
                const fileName =
                  typeof element.data?.fileName === 'string' && element.data.fileName
                    ? element.data.fileName
                    : 'image';
                const staged = await stageAccountFile(
                  new File([new Uint8Array(bytes)], fileName),
                  downloadImages,
                );
                Object.assign(raw, {
                  localPath: staged.path,
                  filePath: staged.path,
                  fileSize: staged.size,
                });
              } catch {
                // 预览保留原内容，发送前按可能降级的条数询问。
              }
            }
          }
          segs = snapshot.flatMap((raw, index) => {
            const element = renderElements[index];
            const seg = codecElementToSeg(raw, element);
            return seg ? [seg] : [];
          });
        } else if (msgId) {
          try {
            const raw = await client.account.getRawElements.query({ msgId });
            if (raw?.elements?.length) {
              // 先把缓存里有、元素里没写的媒体路径补上，图片 / 语音才能真正转发出去。
              await hydrateMergeForwardMedia(raw.elements, sendTimeMs);
              segs = codecElementsToSegs(raw.elements, renderElements);
            }
          } catch {
            /* 回读失败就退回渲染元素 */
          }
        }
        if (segs.length === 0) {
          segs = renderElementsToSegs(renderElements);
        }
        if (segs.length === 0) continue;
        const node = createNode(senderInfo, segs, Math.floor(sendTimeMs / 1000));
        const decoration = (message as { decoration?: MfNode['decoration'] }).decoration;
        if (decoration) node.decoration = decoration;
        if (msgId && !message.forwardSnapshot) node.sourceMsgId = msgId;
        nodes.push(node);
      }
      return { ...createEmptyDraft(), id: mfId('draft'), nodes };
    },
    [client, hydrateMergeForwardMedia],
  );

  const handleAddToComposition = useCallback(
    (messages: Message[]) => {
      if (!messages.length) return;
      const scope = messageScopeRef.current;
      void (async () => {
        const config = await client.account.getAccountConfig.query();
        if (
          config?.uin !== user.identityValue ||
          !config.configId ||
          messageScopeRef.current !== scope
        )
          throw new Error('账号已切换，请重新选择消息');
        const draft = await buildMergeForwardDraft(messages);
        if (messageScopeRef.current !== scope) return;
        if (draft.nodes.length !== messages.length)
          throw new Error('部分消息无法导入，原选择已保留');
        await client.mergeForward.archiveAppend.mutate({
          expectedAccountUin: user.identityValue,
          expectedAccountConfigId: config.configId,
          kind: 'material',
          draft,
        });
        await utils.mergeForward.archiveList.invalidate();
        pushToast({
          tone: 'success',
          title: '已添加到素材库',
          detail: `${draft.nodes.length} 条消息`,
        });
      })().catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        pushToast({
          tone: 'error',
          title: '添加到素材库失败',
          source: notificationSource({ kind: 'app', target: { kind: 'composition' } }),
          detail,
        });
      });
    },
    [buildMergeForwardDraft, user.identityValue, pushToast, utils, messageScopeRef],
  );

  const handleSnapshotMerge = useCallback(
    async (messages: Message[], kind: 'c2c' | 'group') => {
      const scope = messageScopeRef.current;
      const binding = pinSession.binding;
      if (!binding) throw new Error('账号尚未就绪，请重新打开聊天记录。');
      const draft = await buildMergeForwardDraft(messages, binding);
      if (scope !== messageScopeRef.current) return;
      const omitted = messages.length - draft.nodes.length;
      const limited = draft.nodes.filter((node) =>
        node.segs.some((seg) => seg.t === 'opaque'),
      ).length;
      if (!draft.nodes.length) throw new Error('所选消息没有可合并转发的内容');
      if (omitted || limited) {
        const confirmed = await useDialog
          .getState()
          .confirm(
            '继续准备合并转发？',
            [
              omitted ? `${omitted} 条没有可转发内容。` : '',
              limited ? `${limited} 条含无法原样发送的内容，发送时将转成文字或跳过。` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            { okLabel: '继续' },
          );
        if (!confirmed || scope !== messageScopeRef.current) return;
      }
      setMergeForwardDraft({
        draft: kind === 'group' ? { ...draft, title: draftTitle(draft.nodes, 'group') } : draft,
        senderMode: 'conversation',
        members: [
          ...new Map(
            draft.nodes.map(({ sender }) => [sender.uid || sender.uin || sender.name, sender]),
          ).values(),
        ],
      });
    },
    [buildMergeForwardDraft, messageScopeRef, pinSession.binding],
  );

  const handleMergeForward = useCallback(
    (messages: Message[], c: Conversation) => {
      if (messages.length === 0) return;
      const members = mergeForwardMembersOf(c);
      void buildMergeForwardDraft(messages)
        .then((draft) =>
          setMergeForwardDraft({
            draft:
              c.type === 'group'
                ? { ...draft, title: draft.title || draftTitle(draft.nodes, 'group') }
                : draft,
            senderMode: 'conversation',
            members,
          }),
        )
        .catch((error) =>
          pushToast({
            tone: 'error',
            title: '准备转发失败',
            source: conversationNotificationSource(c),
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
    },
    [buildMergeForwardDraft, mergeForwardMembersOf, pushToast],
  );

  const persistMergeForwardDraft = useCallback(
    async (draft: MfDraft) => {
      const key = `legacy-composition:${draft.id}`;
      const result = await resolveDraftSave(
        key,
        draft,
        mergeForwardVersions.get(key) ?? draft.version ?? null,
        (expectedVersion) =>
          client.mergeForward.save.mutate({
            id: draft.id,
            title: draft.title,
            createdAt: draft.createdAt,
            nodes: draft.nodes,
            expectedVersion,
          }),
      );
      mergeForwardVersions.set(key, result.current.version);
      if (!result.local) {
        const remote = result.current.value;
        const restored = remote
          ? coerceDraft(remote as Parameters<typeof coerceDraft>[0])
          : createEmptyDraft();
        setMergeForwardDraft(
          (current) =>
            current && { ...current, draft: { ...restored, version: result.current.version } },
        );
      }
      void utils.mergeForward.list.invalidate();
    },
    [utils, mergeForwardVersions],
  );

  /**
   * 发送一份合并转发。
   *
   * 流程：校验草稿 → 生成协议节点（媒体带本机路径，服务端真实上传 + SsoSendLongMsg）
   * → **乐观渲染**一张「聊天记录」卡片到目标会话（私聊同步慢，等不到真消息；群聊同样
   * 受益）。乐观消息只活在前端 state 里，**不落任何缓存 / 不写库**，并带「发送中 /
   * 已发送 / 发送失败」标识。
   */
  const forwardMergeDraft = useCallback(
    async (draft: MfDraft, target: MfTarget, binding?: CompositionBinding) => {
      const pushToast = sourceToastPush(
        conversationNotificationSource({ id: target.conv, type: target.kind }),
      );
      const problem = validateDraft(draft);
      if (problem) throw new Error(problem);
      const nodes = draftToSendNodes(draft);
      const peerType = target.kind === 'group' ? 'group' : 'c2c';
      const title = draft.title || draftTitle(draft.nodes);
      const preview = draftCardPreview(draft);
      const optimisticId = `optimistic-${mfId('of')}`;
      setOptimisticForwards((current) => [
        ...current,
        {
          id: optimisticId,
          convId: target.id,
          afterSeq: outgoingAfterSeq(target.id),
          title,
          count: draft.nodes.length,
          preview,
          state: 'sending',
          at: Date.now(),
        },
      ]);
      const patch = (next: Partial<OptimisticForward>): void =>
        setOptimisticForwards((current) =>
          current.map((item) => (item.id === optimisticId ? { ...item, ...next } : item)),
        );
      try {
        const outcome = await client.account.sendForward.mutate({
          ...outgoingReceipt(optimisticId),
          expectedAccountUin: user.identityValue,
          ...binding,
          peerType,
          targetId: target.conv,
          title: draft.title || undefined,
          nodes,
        });
        if (!outcome.ok) {
          const reason = outcome.card?.errMsg || outcome.hint || '发送失败';
          patch({ state: 'failed', error: reason });
          throw new Error(reason);
        }
        // 卡片那一步的回执带 random / seq：与 Ark 同款，cid 用于对账、seq 用于
        // 混排进真实消息之间（见 OptimisticForward.seq）。
        const cardKeys = expectedKeysOf({
          peerType,
          ...(outcome.card?.groupSequence !== undefined
            ? { groupSequence: outcome.card.groupSequence }
            : {}),
          ...(outcome.card?.privateSequence !== undefined
            ? { privateSequence: outcome.card.privateSequence }
            : {}),
          ...(outcome.card?.random !== undefined ? { random: outcome.card.random } : {}),
        });
        patch({
          state: 'sent',
          resId: outcome.resId,
          ...(cardKeys.cid ? { cid: cardKeys.cid } : {}),
          ...(cardKeys.seq ? { seq: cardKeys.seq } : {}),
          ...(cardKeys.seqRejected ? { seqRejected: true } : {}),
        });
        if (cardKeys.seqRejected) {
          pushToast({
            tone: 'warning',
            message: '聊天记录卡片可能未被服务端接收',
            detail:
              '承载卡片的那步回了成功但没分配消息序号 —— 内容已上传，但收端很可能看不到这张卡。' +
              '请让对方确认；若没有，重发一次。',
          });
        }
      } catch (error) {
        patch({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
        pushToast({
          tone: 'error',
          message: '发送失败',
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [client, pushToast, user.identityValue, outgoingAfterSeq, outgoingReceipt],
  );

  const handleSelectConversation = useCallback(
    (conversationId: string) =>
      settingsNavigation.navigate(() => {
        const row = Object.values(conversationViewsRef.current ?? {})
          .flat()
          .find((item) => item.id === conversationId);
        if (row?.type === 'merged') {
          switchConversationView(aggregateView(row.mergedKind), true);
          return;
        }
        setMobileConversationList(false);
        if (conversationId.startsWith('guild:')) {
          syncDraftsFromPending();
          setSpecialChat('guild');
          setArkFeedState(null);
          setGuildSearchTarget({
            kind: 'guildMessage',
            nodeId: conversationId.slice(6),
            msgId: '',
            msgSeq: '',
            revision: crypto.randomUUID(),
          });
          shell.switchView('messages');
          return;
        }
        if (row?.directoryKind === 'official' || row?.directoryKind === 'service') {
          syncDraftsFromPending();
          setSpecialChat(null);
          setArkFeedState({
            kind: row.directoryKind,
            conversationId: row.id,
            title: conversationRowName(row),
          });
          shell.switchView('messages');
          return;
        }
        // 真正切换到一个普通会话时才关闭 ARK Feed。
        // 先同步回填一次草稿，这样切换那一帧 ChatPane 就能拿到目标会话的正文（它只在
        // conversation.id 变化时读一次 draft）。真正的落库不在这里做 —— 统一交给下面
        // 监听 `shell.activeConversationId` 的 effect 收口，「返回 / 搜索跳转 / 选择器
        // 进入」这些不走本函数的路径也能覆盖到。
        syncDraftsFromPending();
        setSpecialChat(null);
        setArkFeedState(null);
        setSurfaceNavigation((value) => value + 1);
        shell.selectConversation(conversationId);
      }),
    [shell, syncDraftsFromPending, settingsNavigation, switchConversationView],
  );

  useEffect(() => {
    setDeletedIds(new Set());
    setHiddenDeletedIds(new Set());
    // 换会话后缺口要重新判断：上个会话「确认无消息」的缺口 id 与本会话无关。
    setResolvedGaps(new Set());
    automaticGapAttempts.current.clear();
    flashPhotoTried.current.clear();
    flashPhotoAttempts.current.clear();
    // 补丁按会话号分桶存在 sessionStorage：换回来时直接接着用，不重新发包。
    const restored = loadFlashPhotoState(selectedUid ?? '');
    setFlashPhotoPatches(new Map(Object.entries(restored.patches)));
    setFlashPhotoDead(new Set(restored.dead));
  }, [selectedUid, isDirect, isGroup, messageScope]);

  // 补拉成功会解除对应隐藏记录；只同步标记，不再触发时间线重载。
  useEffect(() => {
    if (!selectedUid || !(isDirect || isGroup)) return;
    let alive = true;
    const revision = deletionRevision.current;
    const target = { kind: isGroup ? ('group' as const) : ('c2c' as const), conv: selectedUid };
    void Promise.all([
      client.account.deletedMsgIds.query(target),
      client.account.hiddenDeletedMsgIds.query(target),
    ])
      .then(([ids, hidden]) => {
        if (alive && revision === deletionRevision.current) {
          const nextDeleted = new Set(ids);
          setDeletedIds((current) => shareDeletionIds(current, nextDeleted));
          const nextHidden = new Set(hidden);
          setHiddenDeletedIds((current) => shareDeletionIds(current, nextHidden));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [loaded, selectedUid, isDirect, isGroup, messageScope]);

  const selectedGroupConversationForDetail = shell.selectedGroupConversation;

  // Keep one unread reader alive: DB pings request a refresh, rather than
  // cancelling and restarting an all-conversation scan on every change.
  type UnreadTarget = Parameters<typeof client.account.getUnreadInfos.query>[0]['targets'][number];
  const unreadDirectoryTargets = useMemo(() => {
    const targets = new Map<string, UnreadTarget>();
    const archived = [...(hiddenSessions.data ?? []), ...(deletedSessions.data ?? [])];
    for (const contact of [...recentContactsData, ...archived.filter((row) => row.resolvable)]) {
      const chatType = unreadChatType(contact.chatType);
      if (chatType !== null)
        targets.set(`${chatType}:${contact.targetUid}`, { chatType, uid: contact.targetUid });
    }
    // 群助手成员也加入小表读取，覆盖尚未分页到的群。
    for (const uid of groupAssistantIds) targets.set(`2:${uid}`, { chatType: 2, uid });
    return [...targets.values()];
  }, [recentContactsData, hiddenSessions.data, deletedSessions.data, groupAssistantIds]);
  const unreadDirectoryTargetsRef = useRef(unreadDirectoryTargets);
  unreadDirectoryTargetsRef.current = unreadDirectoryTargets;
  const archivedUnreadRef = useRef(new Map<string, number>());
  archivedUnreadRef.current = new Map(
    [...(hiddenSessions.data ?? []), ...(deletedSessions.data ?? [])].flatMap((row) =>
      row.resolvable && row.unreadCount !== undefined
        ? [[row.targetUid, row.unreadCount] as const]
        : [],
    ),
  );
  initialMessagesPendingRef.current =
    messagesLoading || trackedConversationId !== shell.activeConversationId;
  const requestUnreadRefreshRef = useRef<(() => void) | null>(null);
  const requestNewDirectoryUnreadRef = useRef<(() => void) | null>(null);
  const refreshArchivedUnread = useStableCallback(() => {
    void utils.account.listHiddenSessions.invalidate();
    void utils.account.listDeletedSessions.invalidate();
  });
  useEffect(() => {
    let disposed = false;
    const binding = messageBindingRef.current;
    const source = messageScope;
    const isCurrent = () =>
      !disposed &&
      Boolean(binding) &&
      messageScopeRef.current === source &&
      useViewState.getState().openedUin === openedUin;
    const { guard, changed } = unreadRefreshStateRef.current.bind(source);
    unreadUpdateGuardRef.current = guard;
    if (changed) {
      setReadUndo(null);
      setUnreadByConv({});
      setHighlightsByConv({});
    }

    const targetKey = ({ chatType, uid }: UnreadTarget) => `${chatType}:${uid}`;
    let knownTargets: Set<string> | undefined;
    async function loadUnread(): Promise<boolean> {
      if (!isCurrent() || !binding || !openedUin) return true;
      const startedAt = guard.revision();
      const targets = unreadDirectoryTargetsRef.current;
      knownTargets = new Set(targets.map(targetKey));
      // 共享服务快照一次准备；所有批次返回后只提交一帧角标，不逐会话回填。
      const rows = await readUnreadInfos({ ...binding, targets });
      if (!isCurrent()) return true;
      applyLive(rows, startedAt);
      return !rows.some((row) => row.readError);
    }

    const refresh = createUnreadRefresh(loadUnread);
    type Rows = Awaited<ReturnType<typeof client.account.getUnreadInfos.query>>;
    const applyLive = (rows: Rows, startedAt: number) => {
      const accepted = rows.filter((row) => !row.readError && guard.accepts(row.uid, startedAt));
      if (!accepted.length) return;
      // 实时结果也推进版本，不能被更早启动的全量扫描回灌。
      const finish = guard.begin(accepted.map((row) => row.uid));
      finish();
      setUnreadByConv((current) => {
        const next = { ...current };
        let changed = false;
        for (const row of accepted) {
          const count = archivedUnreadRef.current.get(row.uid) ?? row.unreadCount ?? 0;
          if (next[row.uid] !== count) {
            next[row.uid] = count;
            changed = true;
          }
        }
        return changed ? next : current;
      });
      setHighlightsByConv((current) => {
        const next = { ...current };
        let changed = false;
        for (const row of accepted) {
          if (
            sameUnreadHighlights(
              current[row.uid],
              row.highlights as ConversationHighlight[] | undefined,
            )
          )
            continue;
          changed = true;
          if (row.highlights?.length) next[row.uid] = row.highlights as ConversationHighlight[];
          else delete next[row.uid];
        }
        return changed ? next : current;
      });
    };
    const readTargets = async (targets: UnreadTarget[]) => {
      if (!isCurrent() || !binding) return true;
      const startedAt = guard.revision();
      const rows = await readUnreadInfos({ ...binding, targets });
      if (!isCurrent()) return true;
      applyLive(rows, startedAt);
      return rows
        .filter((row) => row.readError)
        .map((row) => ({ chatType: row.chatType as UnreadTarget['chatType'], uid: row.uid }));
    };
    const liveRefresh = createUnreadTargetRefresh<UnreadTarget>(
      readTargets,
      refresh.request,
      UNREAD_BATCH_SIZE,
    );
    const liveSub = binding
      ? client.account.onUnreadChanged.subscribe(binding, {
          onData(targets) {
            if (!isCurrent()) return;
            if (targets.some((target) => archivedUnreadRef.current.has(target.uid))) {
              refreshArchivedUnread();
            }
            const selection = selectionRef.current;
            for (const target of targets) {
              const kind = target.chatType === 2 ? 'group' : 'c2c';
              conversationWindows.markDirty(conversationWindowKey(source, kind, target.uid));
              if (
                selection?.id === target.uid &&
                (selection.kind === 'group' ? 'group' : 'c2c') === kind
              )
                void refreshWindow();
            }
            refreshRecentHead();
            refreshRecentTargets(targets.map((target) => target.uid));
            liveRefresh.request(
              targets.flatMap((target) => {
                const chatType = unreadChatType(target.chatType);
                return chatType === null ? [] : [{ ...target, chatType }];
              }),
            );
          },
          onError(error) {
            console.error('[unread] 实时未读订阅失败', error);
          },
        })
      : null;
    requestUnreadRefreshRef.current = refresh.request;
    requestNewDirectoryUnreadRef.current = () => {
      if (!knownTargets) return;
      const current = new Set<string>();
      const added: UnreadTarget[] = [];
      for (const target of unreadDirectoryTargetsRef.current) {
        const key = targetKey(target);
        current.add(key);
        if (!knownTargets.has(key)) added.push(target);
      }
      knownTargets = current;
      if (added.length) liveRefresh.request(added, false);
    };
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') refresh.request();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    refresh.request();
    return () => {
      disposed = true;
      liveSub?.unsubscribe();
      liveRefresh.dispose();
      refresh.dispose();
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      requestUnreadRefreshRef.current = null;
      requestNewDirectoryUnreadRef.current = null;
    };
  }, [
    openedUin,
    messageScope,
    conversationWindows,
    refreshRecentHead,
    refreshRecentTargets,
    refreshWindow,
    messageBindingRef,
    messageScopeRef,
    selectionRef,
    refreshArchivedUnread,
  ]);
  useEffect(() => {
    if (!IS_WEB) return;
    return useWebConnection.subscribe((state, previous) => {
      if (state.recovery === previous.recovery) return;
      conversationWindows.markDirty();
      refreshRecentHead();
      refreshRecentTargets();
      requestUnreadRefreshRef.current?.();
      void refreshWindow();
    });
  }, [conversationWindows, refreshRecentHead, refreshRecentTargets, refreshWindow]);
  useEffect(() => {
    requestNewDirectoryUnreadRef.current?.();
  }, [unreadDirectoryTargets]);

  useConversationWindowSelection(messageWindow, {
    activeConversationId: shell.activeConversationId,
    selectedUid,
    isDirect,
    isGroup,
    selectedMessageWindowKey,
    messagesTabActive,
    readFromFirstUnread: displaySettings.data?.readFromFirstUnread ?? false,
    onScopeChange: () => {
      setConversationPrefs({});
      setOptimisticMessages([]);
      setOptimisticForwards([]);
      setOptimisticArks([]);
    },
  });

  const [groupExtrasId, setGroupExtrasId] = useState<string | null>(null);
  useEffect(() => {
    if (!isGroup || !selectedUid || messagesLoading) return undefined;
    const timer = setTimeout(() => setGroupExtrasId(selectedUid), 250);
    return () => clearTimeout(timer);
  }, [selectedUid, isGroup, messagesLoading, setTimeout]);
  const groupExtrasReady = Boolean(
    isGroup && selectedUid && !messagesLoading && groupExtrasId === selectedUid,
  );

  const groupDetail = trpc.account.getGroupDetail.useQuery(
    { groupCode: selectedUid },
    { enabled: groupExtrasReady },
  );
  const groupBulletins = trpc.account.listGroupBulletins.useQuery(
    { groupCode: selectedUid, limit: 10, offset: 0 },
    { enabled: groupExtrasReady },
  );
  const groupEssence = trpc.account.listGroupEssenceMessages.useQuery(
    { groupCode: selectedUid, limit: 10, offset: 0 },
    { enabled: groupExtrasReady },
  );
  // 打开群聊时把该群全部精华 msgSeq 拉下来（只查本地 group_essence 表，不联网），
  // 供聊天窗口给对应消息打「精华」角标。
  const groupEssenceSeqs = trpc.account.listGroupEssenceSeqs.useQuery(
    { groupCode: selectedUid },
    {
      enabled: groupExtrasReady,
      staleTime: 5 * 60 * 1000,
      refetchInterval: () =>
        messagesTabActive && sendAvailable
          ? essenceRefreshInterval(essenceReceipts, essenceSourceKey, Number(selectedUid))
          : false,
      refetchIntervalInBackground: false,
    },
  );
  // 尝试从 Web API 获取带消息内容的精华消息（需要在线账号/有效 cookie）
  const groupEssencePage = trpc.account.getGroupEssencePageWithContent.useQuery(
    { groupCode: selectedUid, pageStart: 0, pageLimit: GROUP_ESSENCE_ONLINE_LIMIT },
    {
      enabled: groupExtrasReady,
      retry: false,
      staleTime: 5 * 60 * 1000,
      refetchInterval: () =>
        messagesTabActive && sendAvailable
          ? essenceRefreshInterval(essenceReceipts, essenceSourceKey, Number(selectedUid))
          : false,
      refetchIntervalInBackground: false,
    },
  );
  const groupEssenceWeb = { ...groupEssencePage, data: groupEssencePage.data?.messages };
  const completeOnlineEssence = hasCompleteEssenceSnapshot({
    success: groupEssenceWeb.isSuccess,
    complete: groupEssencePage.data?.complete === true,
    updatedAt: groupEssenceWeb.dataUpdatedAt,
    localUpdatedAt: Math.max(groupEssence.dataUpdatedAt, groupEssenceSeqs.dataUpdatedAt),
  });
  const effectiveEssenceSeqs = useMemo(
    () =>
      essenceSequences(essenceReceipts, essenceSourceKey, Number(selectedUid), [
        ...(completeOnlineEssence
          ? []
          : (groupEssenceSeqs.data ??
            (groupEssence.data ?? [])
              .filter((item) => item.setStatus === 1)
              .map((item) => String(item.msgSeq)))),
        ...(groupEssenceWeb.data ?? []).map((item) => String(item.msgSeq)),
      ]),
    [
      essenceReceipts,
      essenceSourceKey,
      selectedUid,
      groupEssenceSeqs.data,
      groupEssence.data,
      groupEssenceWeb.data,
      completeOnlineEssence,
    ],
  );
  useEffect(() => {
    if (!essenceSourceKey || !groupExtrasReady || !messagesTabActive) return;
    const reconcile = () => {
      if (
        Object.values(essenceReceipts).some(
          (receipt) =>
            receipt.source === essenceSourceKey &&
            receipt.groupId === Number(selectedUid) &&
            !receipt.pending &&
            Date.now() - receipt.at >= ESSENCE_RECEIPT_TTL,
        )
      )
        pushToast({
          tone: 'warning',
          message: '精华状态同步未确认，已重新显示读取结果',
          source: notificationSource({
            kind: 'conversation',
            conversationKind: 'group',
            conv: selectedUid,
          }),
        });
      useQQEssence.getState().reconcile(
        essenceSourceKey,
        Number(selectedUid),
        groupEssenceSeqs.data ?? [],
        groupEssenceSeqs.dataUpdatedAt,
        (groupEssenceWeb.data ?? []).map((item) => String(item.msgSeq)),
        groupEssenceWeb.dataUpdatedAt,
      );
    };
    reconcile();
    const deadlines = Object.values(essenceReceipts)
      .filter(
        (receipt) =>
          receipt.source === essenceSourceKey &&
          receipt.groupId === Number(selectedUid) &&
          !receipt.pending &&
          receipt.at + ESSENCE_RECEIPT_TTL > Date.now(),
      )
      .map((receipt) => receipt.at + ESSENCE_RECEIPT_TTL);
    if (!deadlines.length) return;
    const timer = setTimeout(reconcile, Math.max(1, Math.min(...deadlines) - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [
    essenceSourceKey,
    groupExtrasReady,
    selectedUid,
    essenceReceipts,
    groupEssenceSeqs.data,
    groupEssenceSeqs.dataUpdatedAt,
    groupEssenceWeb.data,
    groupEssenceWeb.dataUpdatedAt,
    pushToast,
    messagesTabActive,
    setTimeout,
  ]);
  const groupLevelInfo = trpc.account.getGroupMemberLevelInfo.useQuery(
    { groupCode: selectedUid },
    { enabled: groupExtrasReady },
  );
  const groupExt = trpc.account.getGroupExt.useQuery(
    { groupCode: selectedUid },
    { enabled: groupExtrasReady },
  );
  // 「已退群成员」：与群公告 / 群精华同一层 —— 灯箱打开时才查本地 group_member3
  // （64016=1），一次拉一页就够，不碰协议。
  const groupLeftMembers = trpc.account.listGroupLeftMembers.useQuery(
    { groupCode: groupLeftMembersDialog?.groupCode ?? '', limit: 200 },
    { enabled: Boolean(groupLeftMembersDialog) },
  );
  const groupLeftMemberRows = useMemo<GroupLeftMemberRow[]>(
    () =>
      (
        (groupLeftMembers.data ?? []) as Array<{
          uid: string;
          uin: string;
          card: string;
          nick: string;
        }>
      ).map((member) => ({
        id: member.uid,
        displayName: displayGroupMemberName(
          member.card,
          profileByUid.get(member.uid)?.remark,
          member.nick || profileByUid.get(member.uid)?.nick,
          member.uin || member.uid || 'Member',
        ),
        identity: member.uin && member.uin !== '0' ? member.uin : member.uid,
        avatarUrl: avatarFromUin(member.uin),
      })),
    [groupLeftMembers.data, profileByUid],
  );
  const groupMembersEnabled = Boolean(pinSession.binding && groupExtrasReady && messagesTabActive);
  const groupMembers = useInfiniteQuery({
    ...groupMemberPagesOptions(messageScope, isGroup ? selectedUid : '', (offset, limit) =>
      client.account.listGroupMembers.query({
        ...pinSession.binding,
        groupCode: selectedUid,
        limit,
        offset,
      }),
    ),
    enabled: groupMembersEnabled,
  });
  const selectedGroupMemberWires = useMemo(
    () => mergeMessageMembers<GroupMemberWire>([], groupMembers.data?.pages.flat() ?? []),
    [groupMembers.data],
  );
  const selectedGroupMembersLoading =
    groupMembers.isInitialLoading || groupMembers.isFetchingNextPage;
  const selectedGroupMembersError = groupMembers.isError
    ? groupMembers.error instanceof Error
      ? groupMembers.error.message
      : String(groupMembers.error)
    : groupMembers.data?.pages[0]?.length === 0
      ? '数据库中没有该群的成员信息'
      : null;
  useEffect(() => {
    if (!isGroup || !selectedGroupMemberWires.length) return;
    setSenderMemberPages((current) => ({
      ...current,
      [selectedUid]: mergeMessageMembers(current[selectedUid] ?? [], selectedGroupMemberWires),
    }));
  }, [isGroup, selectedUid, selectedGroupMemberWires]);

  useEffect(() => {
    const binding = messageBindingRef.current;
    if (!messageScope || !binding) return;
    const refresh = createUnreadRefresh(async () => {
      if (messageScopeRef.current !== messageScope) return true;
      groupMemberLookup.invalidate();
      invalidateCachedMembers();
      invalidatePreviewMembers();
      setGroupInfoRevision((revision) => revision + 1);
      await Promise.all([
        refreshGroupMemberPages(queryClient, messageScope),
        utils.account.getGroupDetail.invalidate(),
        utils.account.getGroupExt.invalidate(),
        utils.account.getGroupMemberLevelInfo.invalidate(),
        utils.account.listGroupLeftMembers.invalidate(),
        utils.account.listAllGroups.invalidate(),
      ]);
      return true;
    }, 1000);
    const sub = client.account.onGroupInfoChanged.subscribe(binding, {
      onData() {
        if (messageScopeRef.current === messageScope) refresh.request();
      },
      onError(error) {
        console.error('[group-members] 群资料变更订阅失败', error);
      },
    });
    return () => {
      refresh.dispose();
      sub.unsubscribe();
    };
  }, [
    messageScope,
    queryClient,
    utils,
    invalidateCachedMembers,
    invalidatePreviewMembers,
    groupMemberLookup,
    messageBindingRef,
    messageScopeRef,
  ]);

  const peerUpdateSource = useRef(noticeAccountKey);
  peerUpdateSource.current = noticeAccountKey;
  const memberReadbackVersions = useRef(new Map<string, number>());
  useEffect(
    () =>
      subscribeQQPeerUpdates(async ({ binding, target }) => {
        const source = `${binding.expectedAccountUin}:${binding.expectedAccountConfigId}`;
        const current = () => peerUpdateSource.current === source;
        if (!current()) return;
        if (target.kind === 'profile') {
          await refreshProfileCache([target.uid], current, (uids) =>
            client.account.qqWrite.profileDetails.query({ ...binding, uids }),
          );
          return;
        }
        const key = `${source}:${target.groupCode}:${target.uid}`;
        const version = (memberReadbackVersions.current.get(key) ?? 0) + 1;
        memberReadbackVersions.current.set(key, version);
        const member = await client.account.qqWrite.memberDetails.query({
          ...binding,
          groupId: Number(target.groupCode),
          uid: target.uid,
        });
        const queryKey = groupMemberPagesKey(
          JSON.stringify([binding.expectedAccountUin, binding.expectedAccountConfigId]),
          target.groupCode,
        );
        if (!member || !current() || version !== memberReadbackVersions.current.get(key)) return;
        const filters = { queryKey, exact: true };
        const wasFetching = queryClient.isFetching(filters) > 0;
        if (wasFetching) await queryClient.cancelQueries(filters);
        if (!current() || version !== memberReadbackVersions.current.get(key)) return;
        const needsRefetch = wasFetching || queryClient.getQueryState(queryKey)?.isInvalidated;
        const rows = [member];
        queryClient.setQueryData<InfiniteData<GroupMemberWire[]>>(
          queryKey,
          (previous) =>
            previous && {
              ...previous,
              pages: previous.pages.map((page) => replaceLoadedMembers(page, rows)),
            },
        );
        updateCachedMembers(target.groupCode, rows);
        updatePreviewMembers(target.groupCode, rows);
        if (needsRefetch) void queryClient.invalidateQueries(filters, { cancelRefetch: false });
      }),
    [queryClient, refreshProfileCache, updateCachedMembers, updatePreviewMembers],
  );

  const {
    fetchNextPage: fetchMoreGroupMembers,
    hasNextPage,
    isFetching: groupMembersFetching,
  } = groupMembers;
  const requestMoreGroupMembers = useCallback((): void => {
    if (groupMembersEnabled && hasNextPage && !groupMembersFetching && !selectedGroupMembersError)
      void fetchMoreGroupMembers({ cancelRefetch: false });
  }, [
    fetchMoreGroupMembers,
    groupMembersEnabled,
    groupMembersFetching,
    hasNextPage,
    selectedGroupMembersError,
  ]);

  // 成员 wire → 模板层 GroupMember 的映射。群主 / 等级配置 / bot 名单只有上层有，
  // 所以搜索结果也得走这里 —— 群资料面板的搜索命中与成员分页共用一份渲染形状。
  //
  // 群主 / 等级配置只对「当前打开的群」有数据：给别的群建映射时不能借用，否则会把
  // 当前群的群主身份套到另一个群的人头上。
  const mapGroupMemberForGroup = useCallback(
    (m: GroupMemberWire, groupCode: string): GroupMember =>
      groupMemberWireToMember(m, {
        ownerUid: groupCode === selectedUid ? groupDetail.data?.ownerUid : undefined,
        levelConfigs: groupCode === selectedUid ? (groupLevelInfo.data?.levelConfigs ?? []) : [],
        botUids,
        profileByUid,
      }),
    [selectedUid, groupDetail.data, groupLevelInfo.data, botUids, profileByUid],
  );
  const mapGroupMemberWire = useCallback(
    (m: GroupMemberWire): GroupMember => mapGroupMemberForGroup(m, selectedUid),
    [mapGroupMemberForGroup, selectedUid],
  );

  // `loaded` is already oldest→newest; the template renders in array order.
  //
  // 闪照补丁（`flashPhotoPatches`）在这一层套用：`refreshWindow` 会从本地库整页
  // 重读后直接 `setLoaded(rows)`，把任何写进 `loaded` 的替换冲掉，所以补到的元素
  // 不能存进 `loaded`，只能钉在「本地 msgId → 真元素」这张表上，读时间线时合并。
  const loadedMessageWires = useMemo(
    () =>
      loaded.map((row) => {
        const patched = flashPhotoPatches.get(row.msgId);
        const base = replyMediaRows.get(row) ?? row;
        if (!patched) return base;
        return { ...base, elements: patched.elements, sourceFormat: patched.sourceFormat };
      }),
    [loaded, replyMediaRows, replyMediaRevision, flashPhotoPatches],
  );
  const messageReplyIndex = useMemo(
    () => createReplyPreviewIndex(loadedMessageWires),
    [loadedMessageWires],
  );
  const currentGroupMembers = useMemo(() => {
    if (selectedConversation?.type !== 'group') return [];

    const allMemberWires = [...selectedGroupMemberWires];
    const knownUids = new Set(allMemberWires.map((member) => member.uid));
    // Merge in only THIS group's on-demand-resolved senders.
    const groupMissing = missingMembers[selectedUid] ?? {};
    Object.values(groupMissing).forEach((m) => {
      if (!knownUids.has(m.uid)) {
        knownUids.add(m.uid);
        allMemberWires.push(m);
      }
    });

    // uid / uin 为空的成员是无效行（群成员表里可能有这种占位），不进成员列表 /
    // 成员表 —— 它们解析不出人，只会多出一行空白；uin 为空 / `'0'` 时展示只能退
    // 回 uid，同样没有意义。
    const mapped: GroupMember[] = allMemberWires
      .map(mapGroupMemberWire)
      .filter(
        (member) =>
          String(member.id ?? '').trim() !== '' &&
          String(member.uin ?? '').trim() !== '' &&
          member.uin !== '0',
      );

    return mapped.sort((a, b) => {
      const roleScore = { owner: 0, admin: 1, member: 2 };
      return roleScore[a.role] - roleScore[b.role];
    });
  }, [
    selectedConversation?.type,
    selectedUid,
    selectedGroupMemberWires,
    missingMembers,
    mapGroupMemberWire,
  ]);

  const messageGroupMembers = useMemo(() => {
    const members = new Map(
      mergeMessageMembers(
        senderMemberPages[selectedUid] ?? [],
        Object.values(missingMembers[selectedUid] ?? {}),
      ).map((wire) => {
        const member = mapGroupMemberWire(wire);
        return [member.id, member] as const;
      }),
    );
    for (const member of currentGroupMembers) members.set(member.id, member);
    return members;
  }, [senderMemberPages, missingMembers, selectedUid, mapGroupMemberWire, currentGroupMembers]);

  /**
   * 群资料面板的群内成员搜索。以前面板只在已加载的成员分页里做客户端过滤，
   * 结果是「搜不到后面几页的人」，而且过滤后列表短于容器、没有滚动条，连
   * 加载更多都触发不了。现在关键字交给 `account.searchGroupMembers` 在
   * `group_member3` 上按群搜全群，命中项仍复用同一份 wire → GroupMember 映射
   * （群主 / 等级 / bot 角标与成员分页一致）。
   */
  const [memberSearchKeyword, setMemberSearchKeyword] = useState('');
  const groupMemberSearch = useGroupMemberSearch<GroupMemberWire>(
    isGroup ? selectedUid : undefined,
    memberSearchKeyword,
    mapGroupMemberWire,
    groupInfoRevision,
  );
  const memberSearch = useMemo(
    () => (isGroup && selectedUid ? groupMemberSearch.view : null),
    [isGroup, selectedUid, groupMemberSearch.view],
  );

  // Resolve message senders / gray-tip targets that fall outside the loaded
  // member page. Messages render immediately with the uin fallback; the real
  // card/nick is batched in by useGroupMemberResolver without blocking. Dedup
  // (known page + already-attempted) lives in the resolver, so this effect just
  // hands it every referenced uid.
  useEffect(() => {
    if (!selectedUid || !isGroup) return;
    const groupCode = selectedUid;
    const known = new Set(selectedGroupMemberWires.map((m) => m.uid));
    const referencedUids = [
      user.uid ?? '',
      ...loaded.map((m) => m.senderUid),
      // Gray-tip payloads reference members by uid inside their element bodies
      // (poke/invite XML, mute info) — resolve those too, not just senders.
      ...loaded.flatMap((m) => extractGrayTipUids(m.elements)),
    ];
    resolveMembers(groupCode, referencedUids, known, () => selectionRef.current?.id === groupCode);
    resolveProfiles(referencedUids);
  }, [
    loaded,
    selectedUid,
    isGroup,
    selectedGroupMemberWires,
    resolveMembers,
    resolveProfiles,
    user.uid,
    groupInfoRevision,
    selectionRef,
  ]);

  // 「删除列表」/「撤回列表」里的发送者同样可能落在已加载成员分页之外（甚至已退群），
  // 上面的 effect 只喂了聊天窗口，看不到这两个面板的数据 —— 不补的话气泡昵称会退化成
  // QQ 号。而且这两个面板可以从防撤回面板/会话菜单打开**非当前会话**的群，所以群号
  // 必须取面板自己的会话，不能复用 selectedUid。
  useEffect(() => {
    const panels = [
      { conv: deletedConv, rows: deletedWires },
      { conv: recalledConv, rows: recalledWires },
    ];
    for (const { conv, rows } of panels) {
      if (conv?.type !== 'group' || rows.length === 0) continue;
      const groupCode = conv.group.identityValue || conv.id;
      if (!groupCode) continue;
      // 当前群的成员分页是权威的「已知」集合；别的群没有分页，交给 resolver 的
      // attempted 去重（重复调用不会重复请求）。
      const known: ReadonlySet<string> =
        groupCode === selectedUid ? new Set(selectedGroupMemberWires.map((m) => m.uid)) : new Set();
      const uids = rows.flatMap((m) => [
        m.senderUid,
        // 撤回者是管理员时不是消息发送者，但卡片头要显示他的名字。
        m.recall?.revokeUid ?? '',
        ...extractGrayTipUids(m.elements),
      ]);
      resolveMembers(
        groupCode,
        uids,
        known,
        // 回填进的是 `missingMembers[groupCode]`，按群隔离；面板中途关掉也照样收下，
        // 下次再打开就是现成的（丢弃反而会因 attempted 已记录而永不重试）。
        () => true,
      );
      // 群名片里没有的昵称 / 备注由 profile 缓存兜底（同灰条 / 成员列表）。
      resolveProfiles(uids);
    }
  }, [
    deletedConv,
    deletedWires,
    recalledConv,
    recalledWires,
    selectedUid,
    selectedGroupMemberWires,
    groupInfoRevision,
    resolveMembers,
    resolveProfiles,
  ]);

  // Web 只补当前可见行；完整资料目录另行分批读取，不扫描所有会话的预览发送者。
  useEffect(() => {
    let disposed = false;
    let cancel: (() => void) | undefined;
    let offset = 0;
    const rows = selectProfileContacts(
      recentContactsData,
      IS_WEB ? visibleConversationIds : undefined,
    );
    const resolveBatch = () => {
      if (disposed) return;
      if (initialMessagesPendingRef.current || document.visibilityState === 'hidden') {
        cancel = scheduleBackgroundLoad(resolveBatch, 500);
        return;
      }
      const batch = rows.slice(offset, offset + 30);
      const { uids, groups } = conversationProfileTargets(batch);
      for (const [code, ids] of groups)
        resolvePreviewMembers(code, ids, new Set(), () => !disposed);
      resolveProfiles(uids);
      offset += batch.length;
      if (offset < rows.length) cancel = scheduleBackgroundLoad(resolveBatch);
    };
    cancel = scheduleBackgroundLoad(resolveBatch, 100);
    return () => {
      disposed = true;
      cancel?.();
    };
  }, [
    recentContactsData,
    visibleConversationIds,
    groupInfoRevision,
    resolvePreviewMembers,
    resolveProfiles,
  ]);

  useEffect(() => {
    const binding = messageBindingRef.current;
    if (!IS_WEB || !binding) return;
    const source = messageScope;
    const visible = new Set(visibleConversationIds);
    const missing = recentContactsData.filter(
      (contact) =>
        visible.has(contact.targetUid) &&
        chatTypeKind(contact.chatType) === 'group' &&
        /^\d+$/.test(contact.targetUid) &&
        !contact.targetDisplayName &&
        !contact.targetRemark &&
        !groupNameByCode.get(contact.targetUid),
    );
    let disposed = false;
    let cancel: () => void;
    const resolveNames = () => {
      if (disposed || messageScopeRef.current !== source) return;
      if (initialMessagesPendingRef.current || document.visibilityState === 'hidden') {
        cancel = scheduleBackgroundLoad(resolveNames, 500);
        return;
      }
      void (async () => {
        for (const contact of missing) {
          if (disposed || messageScopeRef.current !== source) return;
          const code = contact.targetUid;
          if (attemptedGroupNames.current.has(code)) continue;
          attemptedGroupNames.current.add(code);
          try {
            const detail = await utils.account.getGroupDetail.fetch(
              { ...binding, groupCode: code },
              { staleTime: 60_000 },
            );
            if (messageScopeRef.current !== source) return;
            if (detail?.groupName)
              setVisibleGroupNames((previous) => ({ ...previous, [code]: detail.groupName }));
          } catch {
            attemptedGroupNames.current.delete(code);
          }
        }
      })();
    };
    cancel = scheduleBackgroundLoad(resolveNames, 100);
    return () => {
      disposed = true;
      cancel();
    };
  }, [
    visibleConversationIds,
    recentContactsData,
    groupNameByCode,
    messageScope,
    utils,
    messageBindingRef,
    messageScopeRef,
    setVisibleGroupNames,
    attemptedGroupNames,
  ]);

  useEffect(() => {
    if (!profiles.isFetched) return;
    const uids: string[] = [];
    for (const buddy of (buddies.data ?? []) as BuddyWire[]) uids.push(buddy.uid);
    for (const request of (buddyRequests.data ?? []) as BuddyRequestWire[])
      uids.push(request.peerUid);
    for (const notify of (groupNotifies.data ?? []) as GroupNotifyWire[]) {
      if (![1, 3, 6, 11, 13, 15].includes(notify.status)) continue;
      if (notify.operatedUid) uids.push(notify.operatedUid);
      if (notify.operatorUid) uids.push(notify.operatorUid);
    }
    // 隐藏会话没有 QQ 预置的显示名列，靠 profile 缓存补昵称/头像（同 buddy 列表）。
    for (const hidden of (hiddenSessions.data ?? []) as HiddenSessionWire[]) {
      if (hidden.resolvable && chatTypeKind(hidden.chatType) === 'direct')
        uids.push(hidden.targetUid);
    }
    // 删除会话同样需要 profile 缓存补昵称/头像。
    for (const deleted of (deletedSessions.data ?? []) as DeletedSessionWire[]) {
      if (deleted.resolvable && (deleted.chatType === 1 || deleted.chatType === 10))
        uids.push(deleted.targetUid);
    }
    resolveProfiles(uids);
  }, [
    buddies.data,
    buddyRequests.data,
    groupNotifies.data,
    hiddenSessions.data,
    deletedSessions.data,
    resolveProfiles,
    directoryReady,
    profiles.isFetched,
  ]);

  const loadSelectionMessages: LoadSelectionMessages = useCallback(
    async (request, onPage, signal) => {
      const binding = messageBindingRef.current,
        scope = messageScopeRef.current;
      if (!binding || !scope) throw new Error('账号或数据源尚未就绪');
      const check = () => {
        signal.throwIfAborted();
        if (messageScopeRef.current !== scope) throw new Error('账号或数据源已切换');
      };
      const { kind, conv } = convFetchKey(request.conversation);
      const start = BigInt(request.startSeq),
        end = BigInt(request.endSeq);
      if (start <= 0n || end < start) throw new Error('消息范围无效');
      const apply = (page: MessageWire[]) => {
        check();
        const members =
          request.conversation.type === 'group'
            ? new Map(request.conversation.members.map((member) => [member.id, member]))
            : undefined;
        const lookupByUin = members ? createMemberUinLookup(members) : undefined;
        const rows = page.filter((row) => BigInt(row.msgSeq) >= start && BigInt(row.msgSeq) <= end);
        onPage(
          rows.map((row) =>
            messageToTemplate(
              row,
              request.conversation,
              user,
              members,
              botUids,
              undefined,
              profileByUid,
              lookupByUin,
            ),
          ),
        );
        if (selectionRef.current?.id !== request.conversation.id) return;
        setLoaded((current) => {
          if (
            messageScopeRef.current !== scope ||
            selectionRef.current?.id !== request.conversation.id
          )
            return current;
          const low = current.find((row) => /^[1-9]\d*$/.test(row.msgSeq))?.msgSeq;
          const high = current.findLast((row) => /^[1-9]\d*$/.test(row.msgSeq))?.msgSeq;
          if (!low || !high) return current;
          const visible = rows.filter(
            (row) => BigInt(row.msgSeq) >= BigInt(low) && BigInt(row.msgSeq) <= BigInt(high),
          );
          if (!visible.length) return current;
          if (request.mode === 'roaming') return mergeRoamingTimeline(kind, current, visible);
          const native = new Map(
            current.filter((row) => row.source !== 'roaming').map((row) => [row.msgId, row]),
          );
          for (const row of visible) native.set(row.msgId, row);
          return mergeRoamingTimeline(
            kind,
            [...native.values()],
            current.filter((row) => row.source === 'roaming'),
          );
        });
      };
      if (request.mode === 'local') {
        let afterSeq: string | undefined;
        for (;;) {
          check();
          const page = await client.account.readSelectionRange.query({
            ...binding,
            kind,
            conv,
            startSeq: request.startSeq,
            endSeq: request.endSeq,
            afterSeq,
            limit: 200,
          });
          check();
          apply(page.items.map(toMessageWire));
          if (page.nextSeq === null) break;
          if (BigInt(page.nextSeq) <= BigInt(afterSeq ?? start - 1n))
            throw new Error('消息范围分页未前进');
          afterSeq = page.nextSeq;
        }
      } else {
        if (end > 0xffffffffn) throw new Error('该序号超出现有漫游协议可读取的范围');
        let cursor = Number(start);
        while (cursor <= Number(end)) {
          check();
          const page = await client.account.fetchGapMessages.query({
            ...binding,
            kind,
            conv,
            startSeq: cursor,
            endSeq: Number(end),
          });
          check();
          if (!page.ok) throw new Error(page.message);
          if (kind === 'c2c' && page.messages.some((row) => !row.ntSeqVerified))
            throw new Error('漫游记录缺少已确认的 NT 序号，不能混入当前选区');
          apply(
            page.messages.map((row) => ({ ...toMessageWire(row), source: 'roaming' as const })),
          );
          if (page.nextStartSeq === null) break;
          if (page.nextStartSeq <= cursor) throw new Error('漫游分页未前进');
          cursor = page.nextStartSeq;
        }
      }
    },
    [
      convFetchKey,
      user,
      botUids,
      profileByUid,
      setLoaded,
      messageBindingRef,
      messageScopeRef,
      selectionRef,
    ],
  );

  const forwardMatches = useMemo(
    () =>
      selectedConversation
        ? matchForwardMessages(
            optimisticForwards,
            loadedMessageWires.filter((wire) => isMineMessage(wire, selectedConversation, user)),
            selectedConversation.id,
            consumedForwardMessages.current,
          )
        : new Map<string, string>(),
    [optimisticForwards, loadedMessageWires, selectedConversation, user],
  );

  const templateContext = messageTemplateContext(selectedConversation);
  const messageTemplateCache = useMemo(
    () => new WeakMap<MessageWire, { message: Message; identityRevision: symbol }>(),
    [templateContext, user],
  );
  // 资料批次更新只校准身份字段，不丢弃未变化正文的转换结果，也不持有旧资料 Map。
  const messageIdentityRevision = useMemo(
    () => Symbol(),
    [messageGroupMembers, botUids, profileByUid],
  );
  const templateMessages = useMemo(() => {
    if (!selectedConversation) return [];
    const mappingStarted = performance.now();

    // Create a fast lookup map for member info
    const memberMap = messageGroupMembers;
    const lookupByUin = createMemberUinLookup(memberMap);
    const optimisticSender = optimisticMessageSender(
      selectedConversation,
      user,
      memberMap,
      lookupByUin,
    );
    const replyIndex = messageReplyIndex;

    const real = loadedMessageWires
      .filter((message) => isRenderableMessage(message))
      .map((message) => {
        const cached = messageTemplateCache.get(message);
        const hasReply = message.elements.some(
          (element) => (element as { type?: string } | null)?.type === 'reply',
        );
        if (cached) {
          let updated = cached.message;
          if (cached.identityRevision !== messageIdentityRevision) {
            const sender = replaceEqualDeep(
              updated.sender,
              messageSender(
                message,
                selectedConversation,
                user,
                memberMap,
                botUids,
                profileByUid,
                lookupByUin,
              ),
            );
            const recallRevokerName = resolveRecallRevokerName(
              message,
              selectedConversation,
              memberMap,
            );
            if (sender !== updated.sender || recallRevokerName !== updated.recallRevokerName)
              updated = { ...updated, sender, senderId: sender.id, recallRevokerName };
          }
          if (hasReply) {
            // 原文补页／编辑仍重新校准引用，但无关窗口变化不重画整条回复。
            const elements = replaceEqualDeep(
              updated.qqElements,
              enrichReplyElements(
                message.elements,
                selectedConversation,
                user,
                memberMap,
                replyIndex,
              ),
            );
            if (elements !== updated.qqElements)
              updated = { ...updated, qqElements: elements as Message['qqElements'] };
          }
          if (updated !== cached.message || cached.identityRevision !== messageIdentityRevision)
            messageTemplateCache.set(message, {
              message: updated,
              identityRevision: messageIdentityRevision,
            });
          return updated;
        }
        const mapped = messageToTemplate(
          message,
          selectedConversation,
          user,
          memberMap,
          botUids,
          replyIndex,
          profileByUid,
          lookupByUin,
        );
        messageTemplateCache.set(message, {
          message: mapped,
          identityRevision: messageIdentityRevision,
        });
        return mapped;
      });
    // 乐观渲染的合并转发（见 {@link mergeOptimisticInto}）。
    const pending = optimisticForwards
      .filter((item) => item.convId === selectedConversation.id && !forwardMatches.has(item.id))
      .map((item) => optimisticToTemplate(item, selectedConversation, optimisticSender));
    // 乐观 Ark 卡片（同上）。
    const pendingArks = optimisticArks
      .filter((item) => item.convId === selectedConversation.id)
      .map((item) => optimisticArkToTemplate(item, selectedConversation, optimisticSender));
    // 乐观普通消息（文本 / @ / 表情 / 图片 / 语音 / 文件…）。
    const pendingMessages = optimisticMessages
      .filter((item) => item.convId === selectedConversation.id)
      .map((item) => optimisticMessageToTemplate(item, selectedConversation, optimisticSender));
    // 确认过的序号按原规则插入；失败按创建时间定位，其余无可靠位置的占位仍留在末尾。
    const mapped = mergeOptimisticInto(real, [...pending, ...pendingArks, ...pendingMessages]);
    recordMessagePhase('mapping', performance.now() - mappingStarted);
    return mapped;
  }, [
    loadedMessageWires,
    selectedConversation,
    user,
    messageGroupMembers,
    botUids,
    optimisticForwards,
    optimisticArks,
    optimisticMessages,
    forwardMatches,
    messageTemplateCache,
    messageIdentityRevision,
    messageReplyIndex,
    profileByUid,
  ]);

  /**
   * 与渲染使用同一份纯对账结果，回执更新也触发；一条真实回声只消费一次。
   */
  useEffect(() => {
    if (!forwardMatches.size) return;
    for (const [id, key] of forwardMatches) {
      while (consumedForwardMessages.current.size >= 512)
        consumedForwardMessages.current.delete(
          consumedForwardMessages.current.keys().next().value!,
        );
      consumedForwardMessages.current.set(key, id);
    }
    setOptimisticForwards((current) => {
      const next = current.filter((item) => !forwardMatches.has(item.id));
      return next.length === current.length ? current : next;
    });
  }, [forwardMatches]);

  /**
   * Ark 卡片的真消息同步回来之后，把对应的乐观条目收掉。判据按可靠性排队：
   *
   *   1. **cid（首选，= 客户端 random）**：`wire.msgRandom` 与发送时记下的 random 相等
   *      —— 精确对账，连位置卡片这种「服务端会重写卡片内容」的也能收掉；群聊私聊通吃；
   *   2. **seq（辅助）**：回执给出的会话内真实 seq（群聊 = 库里 40003；私聊实测也是
   *      「本地 max + 1」那一套）。作为 cid 之后的次要对账判据；
   *   3. **内容签名**（`arkCardSignature`）：位置卡片走坐标，其余走 ark JSON 本体 ——
   *      cid 拿不到时的兜底（例如位置卡片那条 trpc 回包解析不出 random）。
   *
   * 签名可能撞（同一条位置连发两次、同一张卡连发两次），所以按**出现次数**消耗：
   * 同步回来几条就收掉几条，剩下的继续挂着等下一批。
   *
   * 只对**当前会话**的乐观条目对账：`loadedMessageWires` 是当前打开的会话，而
   * `optimisticArks` 可能还有别的会话的条目。seq 判据尤其需要这道闸 —— 它是会话内序号，
   * 别的会话完全可能有同一个数字。
   *
   * 依赖里带上 `optimisticArks` 本身：cid / seq 是**拿到回执才补上**的，如果那一刻
   * 真消息已经到了，必须再跑一轮才能收掉它（没得改时返回同一个数组，不会死循环）。
   */
  useEffect(() => {
    if (optimisticArks.length === 0) return;
    const openConvId = selectedConversation?.id;
    if (!openConvId) return;
    const cids = new Set<string>();
    const seqs = new Set<string>();
    const signatures = new Map<string, number>();
    for (const wire of loadedMessageWires) {
      if (wire.msgRandom && wire.msgRandom !== '0') cids.add(wire.msgRandom);
      if (wire.msgSeq) seqs.add(String(wire.msgSeq));
      for (const element of wire.elements ?? []) {
        if ((element as { type?: string }).type !== 'ark') continue;
        const signature = arkCardSignature(
          String((element as { data?: { arkData?: unknown } }).data?.arkData ?? ''),
        );
        if (signature) signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
      }
    }
    if (cids.size === 0 && seqs.size === 0 && signatures.size === 0) return;
    // 与普通消息那条同一套：结论在 updater 外面算好，不在 updater 里消耗 `signatures`
    // 的计数（开发构建会把 updater 跑两遍、以第二遍为准，副作用会让它漏判）。
    const dropIds = new Set<string>();
    for (const item of optimisticArks) {
      // 别的会话的条目不在这个窗口里，原样留着（见上方注释）。
      if (item.convId !== openConvId) continue;
      if (item.cid && cids.has(item.cid)) {
        dropIds.add(item.id);
        continue;
      }
      if (item.seq && seqs.has(item.seq)) {
        dropIds.add(item.id);
        continue;
      }
      const left = signatures.get(item.signature);
      if (!left) continue;
      signatures.set(item.signature, left - 1);
      dropIds.add(item.id);
    }
    if (dropIds.size === 0) return;
    setOptimisticArks((current) => {
      const next = current.filter((item) => !dropIds.has(item.id));
      return next.length === current.length ? current : next;
    });
  }, [loadedMessageWires, optimisticArks, selectedConversation]);

  /**
   * 普通消息（文本 / 表情 / 媒体 / 文件…）的真消息同步回来后把乐观条目收掉。
   *
   * 判据与 Ark 同：cid（= 客户端 `random`）首选 —— 发送前已知、回执带回、库里 40002
   * 同名；seq 作为次要对账（会话内序号，所以必须限定当前会话）。媒体消息同步本来就
   * 比文本慢，未命中前乐观条目继续显示本地预览。
   */
  useEffect(() => {
    if (!optimisticMessages.some((item) => item.fileSync && item.state !== 'failed')) {
      consumedFileMessages.current.clear();
    }
    if (optimisticMessages.length === 0) return;
    const openConvId = selectedConversation?.id;
    if (!openConvId) return;
    const cids = new Set<string>();
    const seqs = new Set<string>();
    for (const wire of loadedMessageWires) {
      if (wire.msgRandom && wire.msgRandom !== '0') cids.add(wire.msgRandom);
      if (wire.msgSeq) seqs.add(String(wire.msgSeq));
    }
    // 对账结论必须在 updater **外面**算完：updater 里一旦消耗 `signatures` 的计数，它
    // 就不再纯净 —— React 的开发构建会把 updater 跑两遍，**第二次的结果才是最终值**
    // （react-dom `updateReducerImpl`：多跑的那遍丢掉结果，再用同一份 base state 跑一遍）。
    // 第一遍把计数减到 0，第二遍就会当成「签名没命中」而保留乐观消息；闪传 / AI 声聊拿不到
    // cid / seq、只能靠签名对账，于是卡片永远收不掉。
    const dropIds = reconcileFileMessages(
      optimisticMessages,
      loadedMessageWires.filter((wire) => isMineMessage(wire, selectedConversation, user)),
      openConvId,
      consumedFileMessages.current,
    );
    const generated = matchGeneratedMessages(
      optimisticMessages,
      loadedMessageWires.filter((wire) => isMineMessage(wire, selectedConversation, user)),
      openConvId,
      consumedGeneratedMessages.current,
    );
    for (const [id, key] of generated) {
      dropIds.add(id);
      while (consumedGeneratedMessages.current.size >= 512)
        consumedGeneratedMessages.current.delete(
          consumedGeneratedMessages.current.keys().next().value!,
        );
      consumedGeneratedMessages.current.set(key, id);
    }
    for (const item of optimisticMessages) {
      if (item.convId !== openConvId) continue;
      if (item.cid && cids.has(item.cid)) {
        dropIds.add(item.id);
        continue;
      }
      if (item.seq && seqs.has(item.seq)) {
        dropIds.add(item.id);
      }
    }
    if (dropIds.size === 0) return;
    // 乐观条目被真消息收掉后，它持有的本地预览 blob 也就没人用了（闪照）。
    for (const id of dropIds) {
      const url = optimisticBlobs.current.get(id);
      if (!url) continue;
      optimisticBlobs.current.delete(id);
      releaseObjectUrl(url);
    }
    setOptimisticMessages((current) => {
      const next = current.filter((item) => !dropIds.has(item.id));
      return next.length === current.length ? current : next;
    });
  }, [loadedMessageWires, optimisticMessages, selectedConversation, user]);

  // ── 闪照：本地库只剩兜底文案时，按需走协议把真正的元素拉回来 ──────────────
  //
  // 本地库 `40800` 里闪照只有一句 `[闪照]请使用新版手机QQ查看闪照。`，
  // `commonElem(serviceType=3)` 从来没落过库（见 `docs/database/nt_msg/elements/pic.md`）。
  // 服务端漫游里这条消息仍然带着完整元素，所以按它的 seq 拉一个**单条窗口**就能拿到。
  //
  // 约束：
  //   - 只有 QQ 在线能力（在线 QQ + 附加能力）才拉，在线能力受限保持兜底文案；
  //   - **还要等 SSO 会话登记好**（`ssoReady`）。QQ 在线 ≠ 能发包：Linux 上要提权读
  //     内存拿 a2/d2 之后才登记，中间有几十秒空窗，撞进去必然回
  //     「还没有登记 SSO 会话」，拉一次就白费；
  //   - 每条消息最多试几次（`flashPhotoTried` / `flashPhotoAttempts`）：失败按瞬时
  //     / 永久区分，瞬时（SSO 没就绪、网络抖动）放回队列等下一轮，永久（服务端确实
  //     没有这条）才永久停在兜底文案；
  //   - 拉到就整条替换进时间线，渲染成真正的闪照气泡。
  const flashPhotoTried = useRef(new Set<string>());
  /** 每条消息已经尝试过几次（瞬时失败会放回重试队列，但不能无限重打）。 */
  const flashPhotoAttempts = useRef(new Map<string, number>());

  // 凭据就绪（SSO 会话刚登记上）时把所有闪照的重试名额清空：之前因为
  // 「还没有登记 SSO 会话」失败的消息，这时候才真的有可能拉到。同时失效一次
  // 能力状态 —— 订阅事件可能早于 5 秒轮询，提前刷新能让 effect 立刻再跑一轮。
  useEffect(() => {
    const sub = client.account.onOnlineCredentialsReady.subscribe(undefined, {
      onData: () => {
        flashPhotoTried.current.clear();
        flashPhotoAttempts.current.clear();
        void utils.account.getGroupAlbumAccessState.invalidate();
      },
    });
    return () => sub.unsubscribe();
  }, [utils]);
  const flashPhotoPlaceholders = useMemo(() => {
    if (!selectedConversation) return [] as { msgId: string; msgSeq: string }[];
    return loadedMessageWires
      .filter((wire) => {
        const elements = wire.elements ?? [];
        if (elements.length !== 1) return false;
        const element = elements[0] as { type?: string; data?: Record<string, unknown> } | null;
        if (element?.type !== 'text') return false;
        const text = element.data?.textContent;
        return typeof text === 'string' && isFlashPhotoPlaceholderText(text);
      })
      .map((wire) => ({ msgId: wire.msgId, msgSeq: String(wire.msgSeq ?? '') }))
      .filter((row) => /^\d+$/.test(row.msgSeq) && Number(row.msgSeq) > 0);
  }, [loadedMessageWires, selectedConversation]);

  useEffect(() => {
    if (!selectedConversation) return;
    if (!sendAccess.data?.qqOnline || !sendAccess.data.attachEnabled) return;
    // QQ 在线不代表能发 SSO 包：会话物料要提权读出来才登记。没登记就发包只会拿到
    // 「还没有登记 SSO 会话」，白白烧掉这条消息的重试名额（见上面的说明）。
    if (sendAccess.data.ssoReady !== true) return;
    // 待补 = 时间线里还是兜底文案、且没被服务端判死、也没补丁的。
    //
    // `tried` 只用来挡「同一批并发重复入队」，**不能**用来表示放弃：以前把
    // `attempts >= MAX` 也当成不可再试，可一次 effect 就会给全部待补都 +1，
    // 一轮跑完剩下的条目已经没名额了 —— 于是「一次只补 4 条」的那 4 条之后的
    // 消息永远轮不到（实测 6 条闪照只补到第 3、4 条）。
    const pending = flashPhotoPlaceholders.filter(
      (row) =>
        !flashPhotoDead.has(row.msgId) &&
        !flashPhotoPatches.has(row.msgId) &&
        (flashPhotoAttempts.current.get(row.msgId) ?? 0) < FLASH_PHOTO_MAX_ATTEMPTS,
    );
    if (pending.length === 0) return;
    const { kind, conv } = convFetchKey(selectedConversation);
    const selection = selectionRef.current;
    let cancelled = false;
    void (async () => {
      // 一条一条来：全部补完，不再砍成每轮 4 条。串行是为了不打爆服务端，
      // 也保证「补完这一批」这件事本身是确定的。
      for (const row of pending) {
        if (cancelled) return;
        const seq = Number(row.msgSeq);
        if (!Number.isSafeInteger(seq) || seq <= 0) continue;
        flashPhotoAttempts.current.set(
          row.msgId,
          (flashPhotoAttempts.current.get(row.msgId) ?? 0) + 1,
        );
        try {
          const result = await client.account.fetchGapMessages.query({
            kind,
            conv,
            startSeq: seq,
            endSeq: seq,
          });
          if (cancelled || selectionRef.current !== selection) return;
          // 按 seq 挑（不能按 msgId，本地与服务端两套 id），再按结果分类：
          // 瞬时失败 / 空响应 → 下一轮再试；服务端确实没有 → 判死；拿到 → 回填。
          const fetched = result.ok ? pickFlashPhotoFetch(result.messages, row.msgSeq) : null;
          const outcome = classifyFlashPhotoFetch({
            ok: result.ok,
            ...(result.ok ? {} : { reason: result.reason, message: result.message }),
            fetchedRows: result.ok ? result.messages.length : 0,
            picked: fetched !== null,
          });
          if (outcome === 'retry') continue;
          if (outcome === 'give-up' || !fetched) {
            // 服务端这一窗确实没有闪照元素：记进 dead，切会话回来也不再白打请求。
            setFlashPhotoDead((current) => {
              if (current.has(row.msgId)) return current;
              const next = new Set(current);
              next.add(row.msgId);
              void persistFlashPhotoState(conv, flashPhotoPatchesRef.current, next);
              return next;
            });
            continue;
          }
          // 补丁键用**本地** msgId：时间线里的行永远是本地那条，补拉那条只贡献元素。
          setFlashPhotoPatches((current) => {
            const next = new Map(current);
            next.set(row.msgId, {
              elements: fetched.elements,
              sourceFormat: fetched.sourceFormat,
            });
            void persistFlashPhotoState(conv, next, flashPhotoDeadRef.current);
            return next;
          });
        } catch {
          // 请求抛错：次数上限（+1 已在发请求前记过）兜着，别变成死循环。
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    flashPhotoPlaceholders,
    selectedConversation,
    convFetchKey,
    sendAccess.data,
    loaded,
    flashPhotoDead,
    flashPhotoPatches,
    persistFlashPhotoState,
    selectionRef,
  ]);

  // Server acknowledgement can precede the QQ database write, or its watcher
  // may be disabled. Re-read a small number of times without resending anything.
  const pendingSyncKey = [...optimisticMessages, ...optimisticArks, ...optimisticForwards]
    .filter(
      (item) =>
        item.convId === selectedUid && item.state === 'sent' && !outgoingSequenceRejected(item),
    )
    .map((item) => item.id)
    .sort()
    .join('|');
  useEffect(() => {
    if (!pendingSyncKey) return undefined;
    let cancelled = false;
    const selection = selectionRef.current;
    const timers = [0, 1000, 3000, 7000].map((delay) =>
      setTimeout(() => {
        void (async () => {
          await refreshWindow();
          // One bounded history read after local refreshes have had time to settle.
          // It only calls the existing read API; it never resends or writes QQ's DB.
          if (
            delay !== 7000 ||
            cancelled ||
            !selection ||
            selection.kind !== 'direct' ||
            isDatalineUid(selection.id) ||
            selectionRef.current !== selection ||
            !windowRef.current.anchored
          )
            return;
          const current = loadedRef.current;
          const sequences = current
            .map((row) => Number(row.msgSeq))
            .filter((seq) => Number.isSafeInteger(seq) && seq > 0);
          if (!sequences.length) return;
          const last = Math.max(...sequences);
          const endSeq = Math.min(0xffffffff, last + 10);
          const result = await client.account.fetchGapMessages.query({
            kind: 'c2c',
            conv: selection.id,
            startSeq: Math.max(1, endSeq - 29),
            endSeq,
          });
          if (cancelled || selectionRef.current !== selection || !result.ok) return;
          await refreshWindow();
        })().catch((error: unknown) => console.error('[live] server confirmation failed', error));
      }, delay),
    );
    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [pendingSyncKey, refreshWindow, selectionRef, setTimeout, windowRef, loadedRef]);

  // Deleted messages built through the SAME template pipeline as the live chat,
  // so the panel's bubbles match exactly. 成员来源必须按**面板自己的会话**取：
  // 它可以从防撤回面板「记录」页被打开成非当前会话的群，那时 `currentGroupMembers`
  // 是别的群的人。当前群直接用 currentGroupMembers，别的群用按需解析回填的
  // missingMembers（见上面的解析 effect）。
  const memberMapForGroup = useCallback(
    (groupCode: string): Map<string, GroupMember> => {
      if (groupCode === selectedUid) return messageGroupMembers;
      return new Map(
        mergeMessageMembers(
          senderMemberPages[groupCode] ?? [],
          Object.values(missingMembers[groupCode] ?? {}),
        )
          .map((wire) => mapGroupMemberForGroup(wire, groupCode))
          .map((member) => [member.id, member]),
      );
    },
    [selectedUid, messageGroupMembers, senderMemberPages, missingMembers, mapGroupMemberForGroup],
  );
  const resolveRecordsMembers = useStableCallback((groupCode: string, uids: string[]) => {
    resolveMembers(groupCode, uids, new Set(memberMapForGroup(groupCode).keys()), () => true);
  });

  const deletedTemplateMessages = useMemo(() => {
    if (!deletedConv) return [];
    const memberMap =
      deletedConv.type === 'group'
        ? memberMapForGroup(deletedConv.group.identityValue || deletedConv.id)
        : new Map<string, GroupMember>();
    const lookupByUin = createMemberUinLookup(memberMap);
    return deletedWires
      .filter((message) => isRenderableMessage(message))
      .map((message) =>
        messageToTemplate(
          message,
          deletedConv,
          user,
          memberMap,
          botUids,
          undefined,
          profileByUid,
          lookupByUin,
        ),
      );
  }, [deletedWires, deletedConv, user, botUids, memberMapForGroup, profileByUid]);

  // Recalled messages through the SAME template pipeline (bubbles match the chat
  // + carry the 撤回 tag). Same member source as the deleted panel.
  const recalledTemplateMessages = useMemo(() => {
    if (!recalledConv) return [];
    const memberMap =
      recalledConv.type === 'group'
        ? memberMapForGroup(recalledConv.group.identityValue || recalledConv.id)
        : new Map<string, GroupMember>();
    const lookupByUin = createMemberUinLookup(memberMap);
    return recalledWires
      .filter((message) => isRenderableMessage(message))
      .map((message) =>
        messageToTemplate(
          message,
          recalledConv,
          user,
          memberMap,
          botUids,
          undefined,
          profileByUid,
          lookupByUin,
        ),
      );
  }, [recalledWires, recalledConv, user, botUids, memberMapForGroup, profileByUid]);

  const activeConversation = useMemo(() => {
    if (!selectedConversation) return undefined;
    if (selectedConversation.type !== 'group') return selectedConversation;
    const detail = groupDetail.data as GroupDetailWire | null | undefined;

    return {
      ...selectedConversation,
      members: activeGroupMembers(currentGroupMembers),
      group: {
        ...selectedConversation.group!,
        name: detail?.groupName || selectedConversation.group!.name,
        memberCount: detail?.memberCount || selectedConversation.group!.memberCount,
        maxMemberCount: detail?.maxMemberCount || selectedConversation.group!.maxMemberCount,
        announcement: detail?.pinnedAnnounce || selectedConversation.group!.announcement || null,
        description: detail?.description || null,
        remark: detail?.remark || null,
        createTime: secondsToIsoTime(detail?.createTime),
        labels: detail?.labels || null,
        entranceQ: detail?.entranceQ || null,
        customLabels:
          detail?.customLabels
            ?.map((label) => label.content)
            .filter((label): label is string => Boolean(label)) ?? [],
        customLabelRecords: detail?.customLabels ?? selectedConversation.group!.customLabelRecords,
        addressName: detail?.address?.locationName || null,
        bulletins: ((groupBulletins.data ?? []) as GroupBulletinWire[]).map((bulletin, index) => {
          // publisherUid 可能是 UID（数据库）或 UIN（Web API），尝试两者匹配
          const publisher = currentGroupMembers.find(
            (m) => m.id === bulletin.publisherUid || m.identityValue === bulletin.publisherUid,
          );
          return {
            id: bulletin.fid || `bulletin:${index}`,
            text: bulletin.textContent,
            createdAt:
              secondsToIsoTime(bulletin.ctime) ??
              secondsToIsoTime(bulletin.msgTime) ??
              new Date(0).toISOString(),
            publisherUid: bulletin.publisherUid,
            publisherName: publisher?.displayName,
            publisherAvatar: publisher?.avatarUrl,
          };
        }),
        essenceMessages: projectGroupEssence(
          groupEssence.data ?? [],
          groupEssenceWeb.data ?? [],
          completeOnlineEssence,
        ),
        // 该群全部当前为精华的 msgSeq（本地数据库，用于消息右下角「精华」角标）。
        essenceSeqs: effectiveEssenceSeqs,
        levelConfigs: (groupLevelInfo.data?.levelConfigs ?? []).map((item) => ({
          level: item.level,
          name: item.levelName,
        })),
        // 自己的群内身份：成员行的 `id` 是 uid、`identityValue`/`uin` 是 uin，
        // 而 `user.id` 是 `self:<uin>`，两者不同。优先按 uid（`user.uid`）匹配，
        // 其次按 uin；否则群主/管理员会被永远判成普通成员。
        role:
          currentGroupMembers.find(
            (m) =>
              (Boolean(user.uid) && m.id === user.uid) ||
              m.identityValue === user.identityValue ||
              m.uin === user.identityValue,
          )?.role ||
          // 自己的成员行没被加载进当前分页时，至少用群详情里的群主 uid 认出「我」是群主。
          (user.uid && groupDetail.data?.ownerUid === user.uid ? 'owner' : 'member'),
        luckyChar:
          groupExt.data?.luckyCharId && groupExt.data.luckyCharId !== 0
            ? { id: groupExt.data.luckyCharId, litCount: groupExt.data.luckyCharLitCount }
            : null,
      },
    };
  }, [
    selectedConversation,
    currentGroupMembers,
    groupBulletins.data,
    groupDetail.data,
    groupEssence.data,
    groupEssenceWeb.data,
    groupEssenceSeqs.data,
    effectiveEssenceSeqs,
    completeOnlineEssence,
    groupLevelInfo.data,
    groupExt.data,
    user,
  ]);
  // "loading" only until the first page lands; gating on this (not react-query)
  // keeps a switch-into from flashing "还没有消息" before the query resolves.
  const loadingInitialMessages =
    Boolean(selectedConversation) && messagesLoading && loaded.length === 0;

  // ── 未读跳转坞 ──────────────────────────────────────────────────────────
  // 打开会话时的一次性引导：把 msg_unread_info_table 里的未读/高亮读进内存，
  // 随即把该会话标记为已读（清表），右上角再按内存副本逐个引导跳转。
  // 之所以「先读后清」：清表后 48902 就空了，跳转目标只能靠这份内存副本。
  const [unreadDock, setUnreadDock] = useState<UnreadDock | null>(null);
  const seenUnreadHighlights = useMemo(() => new Set<string>(), [messageScope]);
  // 最近一次跳转落空的目标 seq（被撤回 / 删除 / 未同步）。非 null 时聊天区会在
  // 最近邻消息旁渲染一条「点击拉取」的缺口条 —— 因为这种单条缺失 seq 差恰好为 1，
  // 默认的缺口条（只在跳空 >1 时出现）不会渲染，得由这次跳转手动补上入口。
  const [missingJumpSeq, setMissingJumpSeq] = useState<string | null>(null);
  // 正在处理（或已处理完）的会话 id —— 同一个会话只引导一次（分页/刷新不再重复）。
  // 同时兼作「异步结果还是不是当前会话」的判据：await 回来时若已换会话就丢弃。
  const unreadDockRequestRef = useRef<{ convId: string } | null>(null);
  const unreadSnapshotPendingRef = useRef<{ convId: string } | null>(null);
  const readRequestsRef = useRef(new Map<string, { again: boolean; promise: Promise<void> }>());
  useEffect(() => {
    unreadDockRequestRef.current = null;
    unreadSnapshotPendingRef.current = null;
    setUnreadDock(null);
  }, [messageScope]);
  const applyUnreadRows = useCallback(
    (rows: Awaited<ReturnType<typeof client.account.getUnreadInfos.query>>) => {
      setUnreadByConv((current) => {
        const next = { ...current };
        for (const row of rows) if (!row.readError) next[row.uid] = row.unreadCount ?? 0;
        return next;
      });
      setHighlightsByConv((current) => {
        const next = { ...current };
        for (const row of rows) {
          if (row.readError) continue;
          if (row.highlights?.length) next[row.uid] = row.highlights as ConversationHighlight[];
          else delete next[row.uid];
        }
        return next;
      });
    },
    [],
  );
  const markVisibleConversationRead = useCallback(
    async (
      conv: Conversation,
      capturedSnapshot?: Awaited<ReturnType<typeof client.account.getUnreadInfos.query>>[number],
    ) => {
      if (conv.type !== 'direct' && conv.type !== 'group') return;
      const source = messageScopeRef.current;
      const binding = messageBindingRef.current;
      const chatType =
        conv.type === 'group' ? (2 as const) : (unreadChatType(conv.chatType ?? 1) ?? 1);
      const isCurrent = () =>
        Boolean(binding) &&
        messageScopeRef.current === source &&
        messagesTabActiveRef.current &&
        document.visibilityState !== 'hidden' &&
        selectedUidRef.current === conv.id &&
        selectionRef.current?.kind === conv.type &&
        !manualReadPendingRef.current.has(conv.id) &&
        useViewState.getState().openedUin === openedUin;
      if (!isCurrent() || !binding) return;
      const key = `${source}:${conv.type}:${conv.id}`;
      const existing = readRequestsRef.current.get(key);
      if (existing) {
        existing.again = true;
        return existing.promise;
      }
      const entry = { again: false, promise: Promise.resolve() };
      entry.promise = (async () => {
        do {
          entry.again = false;
          if (!isCurrent()) break;
          const finishUpdate = unreadUpdateGuardRef.current.begin([conv.id]);
          try {
            // 摘要可能来自乐观更新或漫游；阅读水位只认带目标身份的小表快照。
            const info =
              capturedSnapshot ??
              (await readUnreadInfos({ ...binding, targets: [{ chatType, uid: conv.id }] }))[0];
            capturedSnapshot = undefined;
            if (
              !isCurrent() ||
              !info ||
              info.readError ||
              info.chatType !== chatType ||
              info.uid !== conv.id ||
              info.latestSeq === null ||
              !/^\d{1,20}$/.test(info.latestSeq)
            )
              break;
            // 固定这次打开时的本地水位，重试不会顺带确认后来到达的新消息。
            const request = {
              chatType,
              uid: conv.id,
              latestSeq: info.latestSeq,
              expectedAccountUin: openedUin ?? undefined,
              expectedAccountConfigId: binding?.expectedAccountConfigId,
            };
            const changed = await retryConversationRead(
              () => client.account.markConversationRead.mutate(request),
              isCurrent,
            );
            if (changed !== null && isCurrent()) {
              const rows = await readUnreadInfos({
                expectedAccountUin: openedUin!,
                expectedAccountConfigId: binding?.expectedAccountConfigId,
                targets: [{ chatType: request.chatType, uid: conv.id }],
              });
              if (isCurrent()) applyUnreadRows(rows);
              if (changed.changed) void utils.account.listRecentContacts.invalidate();
            }
          } catch (error) {
            console.error('[unread] markConversationRead failed', error);
          } finally {
            finishUpdate();
            if (useViewState.getState().openedUin === openedUin)
              requestUnreadRefreshRef.current?.();
          }
        } while (entry.again && isCurrent());
      })().finally(() => {
        readRequestsRef.current.delete(key);
      });
      readRequestsRef.current.set(key, entry);
      return entry.promise;
    },
    [openedUin, utils, applyUnreadRows, messageScopeRef, messageBindingRef, selectionRef],
  );

  async function changeConversationReadState(rows: Conversation[], unread: boolean) {
    const pushToast = sourceToastPush(
      notificationSource({ kind: 'app', target: { kind: 'view', view: 'messages' } }),
    );
    if (!openedUin || readStateBusyRef.current || !rows.length) return;
    const source = messageScopeRef.current;
    const binding = messageBindingRef.current;
    if (!binding) return;
    const isCurrent = () =>
      messageScopeRef.current === source && useViewState.getState().openedUin === openedUin;
    const targets = rows.flatMap((row) =>
      !row.directoryRead && (row.type === 'direct' || row.type === 'group')
        ? [
            {
              chatType:
                row.type === 'group' ? (2 as const) : (unreadChatType(row.chatType ?? 1) ?? 1),
              uid: row.id,
            },
          ]
        : [],
    );
    const directoryTargets = rows.flatMap((row) => (row.directoryRead ? [row.directoryRead] : []));
    if (targets.length + directoryTargets.length !== rows.length || rows.length > 4096) {
      pushToast({
        tone: 'warning',
        durationKind: 'success',
        title: '请选择不超过 4096 个具体会话',
      });
      return;
    }
    readStateBusyRef.current = true;
    setReadStateBusy(true);
    const ids = targets.map((target) => target.uid);
    for (const id of ids) manualReadPendingRef.current.add(id);
    const finish = unreadUpdateGuardRef.current.begin(ids);
    try {
      if (unread && rows.length >= 10) {
        const confirmed = await confirmReadState(
          '批量标为未读',
          `将 ${rows.length} 个会话标为未读，是否继续？`,
          { okLabel: '标为未读', cancelLabel: '取消', tone: 'warning' },
        );
        if (!confirmed || !isCurrent()) return;
      }
      // 已经发出的自动阅读先结束，不能晚于手动未读落地。
      await Promise.all(
        targets.map(
          (target) =>
            readRequestsRef.current.get(
              `${source}:${target.chatType === 2 ? 'group' : 'direct'}:${target.uid}`,
            )?.promise,
        ),
      );
      if (!isCurrent()) return;
      const result = await client.account.setConversationReadState.mutate({
        expectedAccountUin: openedUin,
        expectedAccountConfigId: binding.expectedAccountConfigId,
        targets,
        directoryTargets,
        unread,
      });
      if (!isCurrent()) return;
      applyUnreadRows(result.rows);
      const undo = {
        accountUin: openedUin,
        token: result.undoToken,
        ids,
        action: unread ? ('mark-unread' as const) : ('mark-read' as const),
      };
      readUndoRef.current = undo;
      setReadUndo(undo);
      pushToast({
        tone: result.failed ? 'warning' : 'success',
        title: (
          <span>
            已将{' '}
            <span className="weq-number weq-number-inherit">{rows.length - result.failed}</span>{' '}
            个会话标为{unread ? '未读' : '已读'}
            {result.failed ? `，${result.failed} 个保存失败` : ''}{' '}
            <button
              type="button"
              className="weq-toast-action"
              title="撤销标记"
              aria-label="撤销标记"
              onClick={() => void undoConversationReadState(undo)}
            >
              <Undo2 size={16} />
            </button>
          </span>
        ),
      });
    } catch (error) {
      if (useViewState.getState().openedUin === openedUin)
        pushToast({ tone: 'error', title: '标记失败', detail: String(error) });
    } finally {
      finish();
      for (const id of ids) manualReadPendingRef.current.delete(id);
      readStateBusyRef.current = false;
      setReadStateBusy(false);
      requestUnreadRefreshRef.current?.();
    }
  }

  async function undoConversationReadState(undo = readUndoRef.current) {
    const pushToast = sourceToastPush(
      notificationSource({ kind: 'app', target: { kind: 'view', view: 'messages' } }),
    );
    if (!undo || undo.accountUin !== openedUin || readStateBusyRef.current) return;
    if (readUndoRef.current?.token !== undo.token) {
      pushToast({ tone: 'info', durationKind: 'success', title: '请撤销最近一次标记' });
      return;
    }
    readStateBusyRef.current = true;
    setReadStateBusy(true);
    const finish = unreadUpdateGuardRef.current.begin(undo.ids);
    for (const id of undo.ids) manualReadPendingRef.current.add(id);
    try {
      await Promise.all(
        undo.ids.map(
          (id) =>
            readRequestsRef.current.get(`${openedUin}:direct:${id}`)?.promise ??
            readRequestsRef.current.get(`${openedUin}:group:${id}`)?.promise,
        ),
      );
      if (useViewState.getState().openedUin !== openedUin) return;
      const result = await client.account.undoConversationReadState.mutate({
        expectedAccountUin: undo.accountUin,
        undoToken: undo.token,
      });
      if (useViewState.getState().openedUin !== openedUin) return;
      applyUnreadRows(result.rows);
      readUndoRef.current = null;
      setReadUndo(null);
      pushToast({
        tone: result.pending ? 'warning' : 'info',
        durationKind: result.restored && !result.pending ? 'success' : 'failure',
        title: result.pending
          ? `已撤销 ${result.restored} 个会话的标记，${result.pending} 个正在重试`
          : result.restored
            ? `已撤销 ${result.restored} 个会话的标记`
            : '会话状态已变化，未覆盖最新状态',
      });
    } catch (error) {
      if (useViewState.getState().openedUin === openedUin)
        pushToast({ tone: 'error', title: '撤销失败', detail: String(error) });
    } finally {
      finish();
      for (const id of undo.ids) manualReadPendingRef.current.delete(id);
      readStateBusyRef.current = false;
      setReadStateBusy(false);
      requestUnreadRefreshRef.current?.();
    }
  }
  useReadStateUndo(
    readUndo?.accountUin === openedUin && messagesTabActive && !readStateBusy,
    () => void undoConversationReadState(),
    readUndo?.action,
  );
  const unreadSelectionId =
    selectedConversation &&
    (selectedConversation.type === 'direct' || selectedConversation.type === 'group')
      ? selectedConversation.id
      : null;

  // 换会话立刻收起上一个会话的跳转坞（首屏还没落地时不该继续挂着旧坞）。
  useEffect(() => {
    unreadDockRequestRef.current = null;
    unreadSnapshotPendingRef.current = null;
    setUnreadDock(null);
    setMissingJumpSeq(null);
  }, [unreadSelectionId]);

  useEffect(() => {
    const conv = selectedConversation;
    if (!messagesTabActive) return undefined;
    if (!conv || (conv.type !== 'direct' && conv.type !== 'group')) {
      return undefined;
    }
    // 等首批消息落地后记录未读快照；跳转目标是否可见由聊天视口判断。
    if (messagesLoading || loaded.length === 0) return undefined;
    if (unreadDockRequestRef.current?.convId === conv.id) return undefined;

    const convId = conv.id;
    const request = { convId };
    unreadDockRequestRef.current = request;
    const chatType =
      conv.type === 'group' ? (2 as const) : (unreadChatType(conv.chatType ?? 1) ?? 1);
    const source = messageScopeRef.current;
    const binding = messageBindingRef.current;
    // 只在「还是同一个会话」时落地结果 —— 用 ref 而非 effect cleanup，
    // 因为 loaded / recentContactsData 的后续变化会重跑本 effect（此时早退），
    // 若用 cleanup 的 cancelled 会把刚拿到、还该用的结果一并丢掉。
    const stillCurrent = () => {
      if (!messagesTabActiveRef.current) {
        if (unreadDockRequestRef.current === request) unreadDockRequestRef.current = null;
        return false;
      }
      return (
        Boolean(binding) &&
        messageScopeRef.current === source &&
        selectedUidRef.current === convId &&
        unreadDockRequestRef.current === request
      );
    };

    unreadSnapshotPendingRef.current = request;
    (async () => {
      let info: Awaited<ReturnType<typeof client.account.getUnreadInfos.query>>[number] | undefined;
      try {
        if (!openedUin) return;
        [info] = await readUnreadInfos({
          expectedAccountUin: openedUin,
          expectedAccountConfigId: binding?.expectedAccountConfigId,
          targets: [{ chatType, uid: convId }],
        });
      } catch (err) {
        console.error('[unread-dock] getUnreadInfo failed', err);
        return;
      } finally {
        if (unreadSnapshotPendingRef.current === request) unreadSnapshotPendingRef.current = null;
      }
      if (!stillCurrent() || !info || info.readError) return;

      const readSeq = info.readSeq ?? null;
      const unread = info.unreadCount ?? 0;

      const dock = buildUnreadDock({
        highlights: info?.highlights ?? null,
        readSeq,
        unread,
      });

      // 打开即已读：哪怕一个跳转都不点，也要把 48902 的未读/高亮清掉，
      // 这样下次进来不会再重复弹跳转、红点也即时消失。
      await markVisibleConversationRead(conv, info);
      if (!stillCurrent()) return;
      setUnreadDock(dock);
    })();
    return undefined;
  }, [
    messagesTabActive,
    selectedConversation,
    messagesLoading,
    loaded,
    recentContactsData,
    markVisibleConversationRead,
    openedUin,
    messageScopeRef,
    messageBindingRef,
  ]);

  useEffect(() => {
    // 恢复的会话可能在后续分页、隐藏/删除目录中，不能用尚未读齐的目录清掉选择。
    if (
      !contacts.isSuccess ||
      contacts.isFetching ||
      recentHead.isFetching ||
      contacts.hasNextPage ||
      !hiddenSessions.isSuccess ||
      hiddenSessions.isFetching ||
      !deletedSessions.isSuccess ||
      deletedSessions.isFetching ||
      !allGroups.isSuccess ||
      allGroups.isFetching ||
      !topContacts.isSuccess ||
      topContacts.isFetching
    )
      return;
    // Don't auto-open the first conversation: land on the empty placeholder and
    // let the user pick. Only clear a selection that no longer exists — hidden
    // sessions are deliberately absent from `conversations` (see hiddenConversationsById),
    // so they must be exempted here too or this immediately un-selects them right
    // after the hidden-session picker sets them. Same for deleted sessions.
    if (
      shell.activeConversationId &&
      !conversations.some((conversation) => conversation.id === shell.activeConversationId) &&
      !hiddenConversationsById.has(shell.activeConversationId) &&
      !deletedConversationsById.has(shell.activeConversationId)
    ) {
      shell.setActiveConversationId(null);
    }
  }, [
    contacts.isSuccess,
    contacts.isFetching,
    recentHead.isFetching,
    contacts.hasNextPage,
    hiddenSessions.isSuccess,
    hiddenSessions.isFetching,
    deletedSessions.isSuccess,
    deletedSessions.isFetching,
    allGroups.isSuccess,
    allGroups.isFetching,
    topContacts.isSuccess,
    topContacts.isFetching,
    conversations,
    hiddenConversationsById,
    deletedConversationsById,
    shell.activeConversationId,
    shell.setActiveConversationId,
  ]);

  useMessageReadSelection(messageWindow, { selectedUid, isDirect, isGroup });
  useEffect(() => {
    setMemberSearchKeyword('');
  }, [selectedUid, isDirect, isGroup, messageScope]);

  useEffect(() => {
    const selection = selectionRef.current;
    const binding = messageBindingRef.current;
    const scope = messageScopeRef.current;
    if (!selection || !binding || !scope || !messagesTabActive) return;
    const pending = loaded.filter((row) => needsReplyMedia(row) && !attemptedReplyMedia.has(row));
    if (!pending.length) return;
    for (const row of pending) attemptedReplyMedia.add(row);
    const current = () => messageScopeRef.current === scope && selectionRef.current === selection;
    void (async () => {
      for (let offset = 0; offset < pending.length && current(); offset += 200) {
        const page = pending.slice(offset, offset + 200);
        try {
          const patches = await client.account.replyMedia.query({
            ...binding,
            kind: selection.kind === 'group' ? 'group' : 'c2c',
            conv: selection.id,
            readWindow: selection.readWindow,
            msgIds: page.map((row) => row.msgId),
          });
          if (!current()) return;
          const originals = new Map(page.map((row) => [row.msgId, row]));
          const rows = loadedRef.current;
          const next = applyReplyMedia(rows, originals, patches);
          if (next !== rows) {
            next.forEach((row, index) => {
              if (row !== rows[index]) replyMediaRows.set(rows[index]!, row);
            });
            setReplyMediaRevision((revision) => revision + 1);
          }
        } catch (error) {
          if (current()) console.error('[msgs] reply media failed', error);
        }
      }
    })();
  }, [
    loaded,
    messageScope,
    messagesTabActive,
    selectedUid,
    attemptedReplyMedia,
    replyMediaRows,
    selectionRef,
    messageBindingRef,
    messageScopeRef,
    loadedRef,
    setReplyMediaRevision,
  ]);

  useMessageWindowDescriptor(messageWindow);

  const previewReconciliationRef = useRef('');
  useEffect(() => {
    if (!messageScope || trackedMessageScope !== messageScope || !trackedConversationId) return;
    const unplaced =
      unplacedRoaming?.conversation.id === trackedConversationId ? unplacedRoaming.messages : [];
    if (!anchoredToLatest && !unplaced.length) return;
    const contact = rawRecentContactsData.find((row) => row.targetUid === trackedConversationId);
    if (!contact) return;
    const candidates = unplaced.length ? [...loaded, ...unplaced] : loaded;
    const newest = latestContactPreviewMessage(contact, candidates);
    const latest =
      newest && canPreviewContactMessage(newest)
        ? newest
        : latestContactPreviewMessage(contact, candidates, canPreviewContactMessage);
    setObservedContactPreviews((previous) =>
      observeContactPreview(previous, contact, latest, anchoredToLatest ? loaded : undefined),
    );
    if (!latest || !recentContactPreviewIsBehind(contact, latest)) return;
    // 漫游摘要独立于 QQ 最近会话表，重读旧表不能补齐它。
    if (latest.source === 'roaming') return;
    const key = JSON.stringify([
      messageScope,
      trackedConversationId,
      latest.msgId,
      latest.msgSeq,
      latest.sendTime,
    ]);
    if (previewReconciliationRef.current === key) return;
    previewReconciliationRef.current = key;
    // 只校准最新页；同一消息只请求一次，失败由刷新队列退避重试。
    refreshRecentHead();
  }, [
    loaded,
    unplacedRoaming,
    anchoredToLatest,
    trackedConversationId,
    trackedMessageScope,
    messageScope,
    rawRecentContactsData,
    refreshRecentHead,
  ]);

  // Scroll the loaded list to a message row by id and briefly flash it.
  const { run: runMessageLocate, cancel: cancelMessageLocate } = useMessageLocateFeedback(
    `${messageScope}:${shell.view}:${selectedUid ?? ''}`,
  );
  const scrollToMsgId = useCallback(
    (msgId: string, flash = true): boolean => {
      const scroll = nativeMessageScrollRef.current;
      return scroll ? revealTimelineMessage(scroll, msgId, flash) : false;
    },
    [nativeMessageScrollRef],
  );

  // Rebuild the loaded window centred on `targetSeq` straight from the DB,
  // discarding whatever is loaded now. Keeps long jumps (reply to an ancient
  // message, or search → jump years back) constant-cost instead of loading
  // everything between the latest and the target.
  //
  // The target seq does NOT have to exist as a row: when QQ never synced it
  // (recalled / deleted / unsynced hole) we STILL swap in the window centred on
  // that seq. Landing there makes the neighbouring rows' seq gap render the
  // clickable 「此处有 N 条消息缺失 · 点击拉取」 divider, and Toast explains the
  // miss — i.e. the user can pull the missing messages instead of being dumped
  // back at the latest page. 普通未读跳转只要求找到区间内第一条真实消息。
  // `conv`/`kind` are passed explicitly so it works right after a conversation
  // switch (before selectionRef settles).
  const centerWindowOnSeq = useCallback(
    (
      conv: string,
      kind: 'group' | 'c2c',
      targetSeq: string,
      exactRecord?: ChatMsgWire,
      messageId?: string,
      mode?: ReplyJumpTarget['mode'],
      importantMessage?: ReplyJumpTarget['importantMessage'],
    ): Promise<boolean> =>
      runMessageLocate(
        async (isCurrent) => {
          const pushToast = sourceToastPush(
            notificationSource({ kind: 'conversation', conversationKind: kind, conv }),
          );
          const scope = messageScopeRef.current,
            binding = messageBindingRef.current,
            revision = dbRevisionRef.current;
          const previousSelection = selectionRef.current?.id === conv ? selectionRef.current : null;
          if (!scope || !binding) return false;
          let before: ChatMsgWire[];
          let after: ChatMsgWire[];
          try {
            [before, after] = await Promise.all([
              // `< target+1` is `<= target`, so the centre message is included.
              client.account.listBefore.query({
                ...binding,
                readWindow: previousSelection?.readWindow,
                deferReplyMedia: true,
                kind,
                conv,
                beforeSeq: String(BigInt(targetSeq) + 1n),
                limit: PAGE_SIZE,
              }),
              client.account.listAfter.query({
                ...binding,
                readWindow: previousSelection?.readWindow,
                deferReplyMedia: true,
                kind,
                conv,
                afterSeq: targetSeq,
                limit: PAGE_SIZE,
              }),
            ]);
          } catch (err) {
            if (!isCurrent() || scope !== messageScopeRef.current) return false;
            console.error('[centerWindowOnSeq] fetch failed', err);
            pushToast({
              tone: 'info',
              durationKind: 'failure',
              title: mode === 'firstUnread' ? '未读消息加载失败' : '未找到该消息',
              detail:
                mode === 'firstUnread'
                  ? err instanceof Error
                    ? err.message
                    : String(err)
                  : '该消息可能已被撤回或删除。',
            });
            return false;
          }
          if (
            !isCurrent() ||
            scope !== messageScopeRef.current ||
            selectionRef.current?.id !== conv ||
            (previousSelection !== null && selectionRef.current !== previousSelection)
          ) {
            return false; // switched away mid-flight
          }

          const seen = new Set<string>();
          let merged: MessageWire[] = [];
          // before is DESC (newest-first) incl. centre → reverse to ASC; after is ASC.
          for (const m of [...before.map(toMessageWire).reverse(), ...after.map(toMessageWire)]) {
            if (seen.has(timelineRowKey(m))) continue;
            seen.add(timelineRowKey(m));
            merged.push(m);
          }

          if (exactRecord && !merged.some((message) => message.msgId === exactRecord.msgId))
            merged.unshift(toMessageWire(exactRecord));
          const exactId = messageId ?? exactRecord?.msgId;
          const findTarget = () =>
            mode === 'firstUnread'
              ? firstUnreadMessage(merged, targetSeq)
              : exactId
                ? findTimelineMessageById(merged, exactId, targetSeq)
                : merged.find((m) => matchesUnreadMessage(m, targetSeq, importantMessage));
          let target = findTarget();

          const autoContext = () =>
            preferenceValue('autoFetchMissingMessages') ||
            preferenceValue('autoFetchMissingContext');
          const current = () =>
            isCurrent() &&
            scope === messageScopeRef.current &&
            selectionRef.current?.id === conv &&
            (previousSelection === null || selectionRef.current === previousSelection);
          if (!target && autoContext()) {
            try {
              const rows = await fetchMissingContext(
                targetSeq,
                preferenceValue('autoFetchMissingMessages')
                  ? preferenceDefaults.missingMessageContextCount
                  : preferenceValue('missingMessageContextCount'),
                (range) =>
                  client.account.fetchGapMessages.query({ ...binding, kind, conv, ...range }),
                () => current() && autoContext(),
              );
              if (!current()) return false;
              merged = mergeRoamingTimeline(
                kind,
                merged,
                rows
                  .filter((row) => kind === 'group' || row.ntSeqVerified === true)
                  .map((row) => ({ ...toMessageWire(row), source: 'roaming' as const })),
              );
              target = findTarget();
            } catch (error) {
              if (!current()) return false;
              pushToast({
                tone: 'warning',
                title: '自动拉取上下文失败',
                detail: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (!current()) return false;
          if (!target && mode === 'firstUnread') {
            pushToast({
              tone: 'info',
              durationKind: 'failure',
              title: '未找到可定位的未读消息',
              detail: '本地未读区间暂无可用消息，可稍后重试或拉取缺失消息。',
            });
            return false;
          }
          if (target) setMissingJumpSeq(null);

          const atLatest = after.length < PAGE_SIZE && (!exactRecord || BigInt(targetSeq) > 0n);
          // Update the live-subscription's window descriptor synchronously: a
          // db-changed tick between this setLoaded and the passive windowRef effect
          // must not see the stale (anchored, old-minSeq) descriptor and replace our
          // freshly-jumped window via refreshWindow's listFrom.
          windowRef.current = { minSeq: merged[0]?.msgSeq ?? null, anchored: atLatest };
          setLoaded(merged);
          verifiedWindowRowsRef.current = merged;
          loadedRevisionRef.current = revision;
          windowVerifiedAtRef.current = Date.now();
          setMessagesLoading(false);
          setHasOlder(before.length >= PAGE_SIZE);
          setHasNewer(!atLatest);
          // If the centre sits near the tail, re-anchor so live messages flow in;
          // otherwise stay detached so refreshWindow won't drag us to the latest.
          setAnchoredToLatest(atLatest);
          // Exact row present → flash it. Otherwise fall back to the nearest real
          // message: the clickable gap divider sits right beside it.
          const anchor = target ?? nearestBySeq(merged, targetSeq);
          if (!target) {
            setMissingJumpSeq(targetSeq);
            pushToast({
              tone: 'info',
              durationKind: 'success',
              title: '未找到该条消息',
              detail: '该消息可能已被撤回、删除或未同步。已定位到它附近，可在缺口条上点击拉取。',
            });
          }
          if (anchor) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 160));
            if (!current()) return false;
            const positioned = scrollToMsgId(timelineRowKey(anchor), Boolean(target));
            if (target && !positioned && (exactId || importantMessage || mode === 'firstUnread')) {
              pushToast({ tone: 'info', title: '目标消息未在当前时间线显示' });
              return false;
            }
          }
          return Boolean(target);
        },
        notificationSource({ kind: 'conversation', conversationKind: kind, conv }),
      ),
    [
      scrollToMsgId,
      pushToast,
      runMessageLocate,
      setLoaded,
      messageScopeRef,
      messageBindingRef,
      dbRevisionRef,
      selectionRef,
      windowRef,
      verifiedWindowRowsRef,
      loadedRevisionRef,
      windowVerifiedAtRef,
      setMessagesLoading,
      setHasOlder,
      setHasNewer,
      setAnchoredToLatest,
      setTimeout,
    ],
  );

  // Scroll the loaded message list to a reply target, then briefly flash it. The
  // 40003 anchor lives in a different reply field per kind (verified against the
  // live DB): group → origMsgSeq (47402); c2c → origMsgIndex (47419).
  //
  // Fast vs. slow is decided from the loaded window's seq range — there is no
  // paging probe. The window is a contiguous seq range (holes are recalled /
  // deleted rows, which no fetch can bring back), so:
  //   · target in the window                 → scroll + flash (fast path)
  //   · inside [minSeq, maxSeq] but absent   → a hole: toast, then scroll to the
  //     nearest neighbour so the clickable 「消息缺失 · 点击拉取」 divider shows
  //   · outside the range                    → rebuild a centred window (slow
  //     path, constant-cost 2 queries). If the target turns out to be a hole
  //     there too, we still land beside it and toast.
  const jumpToSeq = useCallback(
    async (jumpTarget: ReplyJumpTarget): Promise<boolean> => {
      const sel = selectionRef.current;
      if (!sel) {
        return false;
      }
      closeForwardWindows();
      cancelMessageLocate();
      setMissingJumpSeq(null);
      if (jumpTarget.msgId) {
        const exact = findTimelineMessageById(
          loadedRef.current,
          jumpTarget.msgId,
          jumpTarget.seq == null ? undefined : String(jumpTarget.seq),
        );
        if (exact && scrollToMsgId(timelineRowKey(exact))) return true;
      }
      const notFound = (): void => {
        pushToast({
          tone: 'info',
          durationKind: 'success',
          title: '未找到该条消息',
          source: notificationSource({
            kind: 'conversation',
            conversationKind: sel.kind === 'group' ? 'group' : 'c2c',
            conv: sel.id,
          }),
          detail: '该消息可能已被撤回、删除或未同步。已定位到它附近，可在缺口条上点击拉取。',
        });
      };
      const kind: 'group' | 'c2c' = sel.kind === 'group' ? 'group' : 'c2c';
      const positive = (value: unknown): string | undefined =>
        /^\d+$/.test(String(value)) && BigInt(String(value)) > 0n ? String(value) : undefined;
      let rawSeq =
        kind === 'group'
          ? (positive(jumpTarget.seq) ?? positive(jumpTarget.index))
          : (positive(jumpTarget.index) ?? positive(jumpTarget.seq));
      if (kind === 'c2c' && positive(jumpTarget.clientSeq) && !positive(jumpTarget.index)) {
        try {
          rawSeq =
            (await client.account.resolveReplySeq.query({
              conv: sel.id,
              clientSeq: String(jumpTarget.clientSeq),
              senderUin: positive(jumpTarget.senderUin),
              sendTime: positive(jumpTarget.sendTime),
            })) ?? undefined;
        } catch (error) {
          console.error('[reply-jump] resolution failed', error);
          rawSeq = undefined;
        }
        if (selectionRef.current !== sel) return false;
      }
      if (rawSeq === undefined || rawSeq === null || rawSeq === '') {
        notFound();
        return false;
      }
      const targetSeq = String(rawSeq);

      const here =
        !jumpTarget.msgId &&
        loadedRef.current.find((m) =>
          matchesUnreadMessage(m, targetSeq, jumpTarget.importantMessage),
        );
      if (here && scrollToMsgId(timelineRowKey(here))) return true;

      const current = loadedRef.current;
      const minSeq = current[0]?.msgSeq;
      const maxSeq = current[current.length - 1]?.msgSeq;
      let targetNum: bigint | null = null;
      try {
        targetNum = BigInt(targetSeq);
      } catch {
        targetNum = null;
      }
      if (minSeq && maxSeq) {
        if (targetNum === null) {
          notFound();
          return false;
        }
        if (targetNum >= BigInt(minSeq) && targetNum <= BigInt(maxSeq)) {
          if (jumpTarget.mode === 'firstUnread') {
            const first = firstUnreadMessage(current, targetSeq);
            if (first && scrollToMsgId(timelineRowKey(first))) return true;
          }
          if (
            jumpTarget.msgId ||
            jumpTarget.importantMessage ||
            preferenceValue('autoFetchMissingMessages') ||
            preferenceValue('autoFetchMissingContext')
          ) {
            return centerWindowOnSeq(
              sel.id,
              kind,
              targetSeq,
              undefined,
              jumpTarget.msgId,
              jumpTarget.mode,
              jumpTarget.importantMessage,
            );
          }
          // 在已加载范围内却没有这一行 ⇒ 一条被撤回/删除/从未同步的「空消息」。
          // 不把用户丢回原地：滚到最近的邻居，并挂一条「点击拉取」的缺口条，
          // 同时 Toast 说明原因。
          notFound();
          setMissingJumpSeq(targetSeq);
          const anchor = nearestBySeq(current, targetSeq);
          if (anchor) scrollToMsgId(timelineRowKey(anchor), false);
          return false;
        }
      }

      return centerWindowOnSeq(
        sel.id,
        kind,
        targetSeq,
        undefined,
        jumpTarget.msgId,
        jumpTarget.mode,
        jumpTarget.importantMessage,
      );
    },
    [centerWindowOnSeq, scrollToMsgId, pushToast, cancelMessageLocate, selectionRef, loadedRef],
  );

  const searchQuery = shell.query.trim();
  const searchAccountKey = noticeAccountKey || openedUin;
  const globalSearch = useGlobalSearch(
    searchQuery,
    searchCategories,
    searchAccountKey,
    searchSources,
  );
  const searchReturn = useSearchReturn(
    searchAccountKey,
    searchQuery,
    searchCategories,
    searchSources,
  );
  useEffect(() => {
    if (searchQuery) setSearchDismissed(false);
  }, [searchQuery]);

  // Jump to a conversation, optionally centred on a message seq (files / chat
  // records). When no seq anchor exists, just open the chat (+toast on demand).
  const jumpToConvSeq = useStableCallback(
    (
      kind: 'group' | 'c2c',
      conv: string,
      seq?: string,
      toastOnMissingSeq = false,
      record?: ChatMsgWire,
      messageId?: string,
      preferredView?: ConversationView,
    ): void => {
      setSearchDismissed(true);
      if (!conv) return;
      closeForwardWindows();
      setChatRecordsTarget(null);
      setGroupSidebarPopover(null);
      setMobileConversationList(false);
      const feed = [
        ...(conversationViewsRef.current?.official ?? []),
        ...(conversationViewsRef.current?.service ?? []),
      ].find((row) => row.id === conv || (row.type === 'direct' && row.otherUser.id === conv));
      setSpecialChat(null);
      if (feed && (feed.directoryKind === 'official' || feed.directoryKind === 'service')) {
        locateConversationInView(feed.id);
        setArkFeedState({
          kind: feed.directoryKind,
          conversationId: feed.id,
          title: conversationRowName(feed),
          anchorId: messageId,
        });
        shell.switchView('messages');
        return;
      }
      locateConversationInView(conv, preferredView);
      setArkFeedState(null);
      if (messageId && messagesTabActive && selectionRef.current?.id === conv) {
        const exact = findTimelineMessageById(loadedRef.current, messageId, seq);
        if (scrollToMsgId(exact ? timelineRowKey(exact) : messageId)) {
          cancelMessageLocate();
          setMissingJumpSeq(null);
          shell.selectConversation(conv);
          return;
        }
      }
      if (!seq) {
        if (toastOnMissingSeq) {
          pushToast({
            tone: 'info',
            durationKind: 'success',
            title: '未找到该消息位置',
            source: notificationSource({ kind: 'conversation', conversationKind: kind, conv }),
            detail: '该消息可能已被撤回或删除。',
          });
        }
        shell.selectConversation(conv);
        return;
      }
      if (messagesTabActive && selectionRef.current?.id === conv) {
        // Already open — jump straight away.
        shell.selectConversation(conv);
        void centerWindowOnSeq(conv, kind, seq, record, messageId);
        return;
      }
      // Switch conversations; the listLatest effect performs the centred jump
      // once the placeholder newest page lands.
      pendingSearchJumpRef.current = { conv, kind, seq, record, messageId };
      shell.selectConversation(conv);
    },
  );

  const handleOpenGroupFiles = useCallback(
    (conversation: Extract<Conversation, { type: 'group' }>) => {
      setGroupSidebarPopover(null);
      openGroupResourceWindow({
        kind: 'files',
        groupCode: conversation.id,
        groupName: conversation.group.name,
        onJumpToMessage: (sequence, messageId) =>
          jumpToConvSeq('group', conversation.id, sequence, false, undefined, messageId),
      });
    },
    [openGroupResourceWindow, jumpToConvSeq],
  );

  // Click a search hit: resolve conversation key + kind,
  // then jump. Files additionally carry a seq anchor.
  const openSearchHit = useCallback(
    (hit: SearchHit): void => {
      setSearchDismissed(true);
      setSearchFocused(false);
      if ((hit.category === 'contact' || hit.category === 'group') && hit.target) {
        if (hit.target.kind === 'guild') {
          setMobileConversationList(false);
          locateConversationInView(`guild:${hit.target.nodeId}`, 'guild');
          setSpecialChat('guild');
          setArkFeedState(null);
          setGuildSearchTarget({
            kind: 'guildMessage',
            nodeId: hit.target.nodeId,
            msgId: '',
            msgSeq: '',
            revision: crypto.randomUUID(),
          });
          shell.switchView('messages');
        } else {
          changeConversationView('clone');
          setMobileConversationList(false);
          setSpecialChat(null);
          setCloneSearchTarget(null);
          setVirtualOpen({ kind: hit.target.kind, id: hit.target.ownerId, revision: Date.now() });
          shell.switchView('agentlab');
        }
        return;
      }
      if (isContentSearchHit(hit)) {
        setSearchDismissed(true);
        const target = hit.target;
        const revision = createMediaId('search');
        switch (target.kind) {
          case 'qzonePost':
          case 'qzoneAlbum':
          case 'qzoneComment':
            setQzoneSpaceRequest({
              accountUin: user.identityValue,
              uin: target.uin,
              revision,
              target:
                target.kind === 'qzonePost' || target.kind === 'qzoneComment'
                  ? {
                      kind: 'post',
                      uin: target.uin,
                      tid: target.tid,
                      ...(target.kind === 'qzoneComment'
                        ? {
                            commentId: target.commentId,
                            parentCommentId: target.parentCommentId,
                            replyId: target.replyId,
                            commentText: hit.content,
                          }
                        : {}),
                    }
                  : { kind: 'album', uin: target.uin, topicId: target.albumId },
            });
            shell.switchView('qzone');
            break;
          case 'mailMessage':
            setMailSearchTarget({ ...target, revision });
            shell.switchView('mail');
            break;
          case 'guildMessage':
            setMobileConversationList(false);
            locateConversationInView(`guild:${target.nodeId}`, 'guild');
            setSpecialChat('guild');
            setArkFeedState(null);
            setGuildSearchTarget({ ...target, revision });
            shell.switchView('messages');
            break;
          case 'marketEmoji':
            // 商城表情已并入个性装扮的「商城表情」页签，搜索直达该页签。
            setDressUpEmojiTarget({ packId: target.packId, name: hit.title, revision });
            setSettingsOpen(false);
            setDressUpOpen(true);
            break;
        }
        return;
      }
      if (hit.category === 'collection') {
        setSearchDismissed(true);
        setCollectionSearchTarget({ cid: hit.cid, revision: Date.now() });
        shell.switchView('collections');
        return;
      }
      if (isGeneratedSearchHit(hit)) {
        setSearchDismissed(true);
        if (hit.category === 'assistantMessage' && hit.sessionId) {
          changeConversationView('assistant');
          openAssistantConversation(hit.sessionId, { ...hit });
        } else {
          changeConversationView('clone');
          setMobileConversationList(false);
          setSpecialChat(null);
          setCloneSearchTarget({ ...hit });
          setConversationLocate({ id: `virtual:${hit.kind}:${hit.ownerId}`, revision: Date.now() });
          shell.switchView('agentlab');
        }
        return;
      }
      if (hit.category === 'contact') {
        if (hit.hasConversation || hit.chatType === 103 || hit.chatType === 118) {
          const id = hit.chatType === 118 ? `service:${hit.uid}` : hit.uid;
          const preferred =
            hit.chatType === 103
              ? 'official'
              : hit.chatType === 118
                ? 'service'
                : hit.conversationView;
          locateConversationInView(id, preferred);
          if (hit.chatType === 103 || hit.chatType === 118) {
            setSpecialChat(null);
            setArkFeedState({
              kind: hit.chatType === 103 ? 'official' : 'service',
              conversationId: id,
              title: hit.remark || hit.nick || hit.uin || hit.uid,
            });
            shell.switchView('messages');
          } else {
            if (
              !conversations.some((row) => row.id === id) &&
              !hiddenConversationsById.has(id) &&
              !deletedConversationsById.has(id)
            )
              setTemporaryConversations((current) => ({
                ...current,
                [id]: {
                  appearedAt: Date.now(),
                  conversation: {
                    id,
                    type: 'direct',
                    directoryKind: 'qq',
                    hidden: preferred === 'hidden',
                    deleted: preferred === 'deleted',
                    chatType: hit.chatType,
                    otherUser: {
                      id,
                      username: hit.nick || id,
                      displayName: hit.remark || hit.nick || hit.uin || id,
                      identityLabel: hit.uin ? 'QQ' : 'UID',
                      identityValue: hit.uin || id,
                      avatarUrl: resolveAvatar({ uin: hit.uin, profileAvatarUrl: hit.avatarUrl }),
                    },
                    group: null,
                    members: [],
                    updatedAt: '',
                    preference: fallbackPreference,
                    unreadCount: 0,
                    lastMessage: null,
                  },
                },
              }));
            jumpToConvSeq('c2c', id, undefined, false, undefined, undefined, preferred);
          }
          return;
        }
        const anchor = document.querySelector('.weq-titlebar-search')?.getBoundingClientRect();
        setMemberCard({
          member: {
            id: hit.uid,
            identityLabel: 'QQ',
            identityValue: hit.uin,
            username: hit.nick || hit.uin || hit.uid,
            displayName: hit.remark || hit.nick || hit.uin || hit.uid,
            avatarUrl: resolveAvatar({ uin: hit.uin, profileAvatarUrl: hit.avatarUrl }),
          },
          anchor: { x: anchor?.left ?? 24, y: anchor?.bottom ?? 48 },
          groupContext: hit.groups[0]
            ? { code: hit.groups[0].groupCode, name: hit.groups[0].groupName }
            : null,
        });
        return;
      }
      if (hit.category === 'group') {
        const known =
          conversations.some((conversation) => conversation.id === hit.groupCode) ||
          hiddenConversationsById.has(hit.groupCode) ||
          deletedConversationsById.has(hit.groupCode);
        if (!known)
          setTemporaryConversations((current) =>
            current[hit.groupCode]
              ? current
              : {
                  ...current,
                  [hit.groupCode]: {
                    appearedAt: Date.now(),
                    conversation: {
                      id: hit.groupCode,
                      type: 'group',
                      updatedAt: new Date(0).toISOString(),
                      hidden: hit.conversationView === 'hidden',
                      deleted: hit.conversationView === 'deleted',
                      otherUser: null,
                      group: {
                        id: hit.groupCode,
                        name: hit.name || hit.groupCode,
                        remark: hit.remark || null,
                        identityLabel: 'Group',
                        identityValue: hit.groupCode,
                        avatarUrl: groupAvatarSrc(hit.groupCode),
                        announcement: null,
                        memberCount: 0,
                        role: 'member',
                      },
                      members: [],
                      preference: fallbackPreference,
                      unreadCount: 0,
                      lastMessage: null,
                    },
                  },
                },
          );
        jumpToConvSeq(
          'group',
          hit.groupCode,
          undefined,
          false,
          undefined,
          undefined,
          hit.conversationView,
        );
        return;
      }
      const kind: 'group' | 'c2c' =
        hit.category === 'conversation'
          ? hit.chatType === 2
            ? 'group'
            : 'c2c'
          : hit.category === 'friend'
            ? 'c2c'
            : hit.category === 'groupMember'
              ? 'group'
              : hit.source === 'group'
                ? 'group'
                : 'c2c';
      const conv =
        hit.category === 'conversation' || hit.category === 'file'
          ? hit.targetUid
          : hit.category === 'friend'
            ? hit.uid
            : hit.category === 'groupMember'
              ? hit.groupCode
              : hit.targetUid;
      if (hit.category === 'file') {
        jumpToConvSeq(kind, conv, hit.msgSeq || undefined, true, undefined, hit.msgId);
      } else {
        jumpToConvSeq(kind, conv);
      }
    },
    [
      jumpToConvSeq,
      searchQuery,
      shell,
      user.identityValue,
      conversations,
      hiddenConversationsById,
      deletedConversationsById,
      setSettingsOpen,
      setDressUpOpen,
      changeConversationView,
      locateConversationInView,
      openAssistantConversation,
    ],
  );

  // 群关键词通知被点击：主进程唤起窗口并记下一个「打开该群、跳到该 seq」的请求，
  // 这里领走并走同一套跳转。每次信号可能积压多条，领到空为止。
  useEffect(() => {
    let cancelled = false;
    const drain = () => {
      void (async () => {
        for (;;) {
          let jump: { groupCode: string; msgSeq: string; msgId?: string } | null = null;
          try {
            jump = await client.bootstrap.consumeGroupKeywordJump.query();
          } catch {
            return;
          }
          if (cancelled || !jump) return;
          jumpToConvSeq('group', jump.groupCode, jump.msgSeq, false, undefined, jump.msgId);
        }
      })();
    };
    const sub = client.bootstrap.onGroupKeywordJump.subscribe(undefined, {
      onData() {
        drain();
      },
      onError(err) {
        console.error('[keyword] onGroupKeywordJump subscription error', err);
      },
    });
    // 订阅建立前主进程可能已积压了跳转（例如窗口刚被通知唤起），先领一次。
    drain();
    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [jumpToConvSeq]);

  useEffect(() => {
    const open = (event: Event) => {
      const notice = (event as CustomEvent<WebNotice>).detail;
      if (
        !notice ||
        notice.uin !== user.identityValue ||
        notice.configId !== noticeConfig.data?.configId
      )
        return;
      if (notice.kind === 'mail') {
        if (notice.mail)
          setMailSearchTarget({
            kind: 'mailMessage',
            ...notice.mail,
            revision: String(Date.now()),
          });
        openMailView();
      } else if (notice.target)
        jumpToConvSeq(
          notice.target.kind,
          notice.target.conv,
          notice.target.seq,
          false,
          undefined,
          notice.target.msgId,
        );
    };
    window.addEventListener(WEB_NOTICE_OPEN, open);
    return () => window.removeEventListener(WEB_NOTICE_OPEN, open);
  }, [jumpToConvSeq, openMailView, user.identityValue, noticeConfig.data?.configId]);

  // 撤回通知被点击：主进程唤起窗口并记下「打开该会话、跳到该 seq」，这里领走。
  // 私聊 / 群聊共用同一条跳转（与群关键词通知同一套机制）。
  useEffect(() => {
    let cancelled = false;
    const drain = () => {
      void (async () => {
        for (;;) {
          let jump: { kind: 'c2c' | 'group'; conv: string; seq?: string; msgId?: string } | null =
            null;
          try {
            jump = await client.bootstrap.consumeConversationJump.query();
          } catch {
            return;
          }
          if (cancelled || !jump) return;
          jumpToConvSeq(jump.kind, jump.conv, jump.seq || undefined, false, undefined, jump.msgId);
        }
      })();
    };
    const sub = client.bootstrap.onConversationJump.subscribe(undefined, {
      onData() {
        drain();
      },
      onError(err) {
        console.error('[recall] onConversationJump subscription error', err);
      },
    });
    drain();
    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [jumpToConvSeq]);

  const { requestOlderMessages, requestNewerMessages } = useConversationWindowEntry(messageWindow, {
    selectedConversation,
    selectedUid,
    isDirect,
    isGroup,
    messagesTabActive,
    loadingInitialMessages,
    readFromFirstUnread: displaySettings.data?.readFromFirstUnread ?? false,
    centerWindowOnSeq,
  });
  // 目标已是选中的会话，但从联系人等页面返回时不会重新触发会话首屏读取。
  useEffect(() => {
    const jump = pendingSearchJumpRef.current;
    if (!messagesTabActive || !jump || jump.conv !== selectedUid) return;
    pendingSearchJumpRef.current = null;
    void centerWindowOnSeq(jump.conv, jump.kind, jump.seq, jump.record, jump.messageId);
  }, [messagesTabActive, selectedUid, pendingSearchJumpRef, centerWindowOnSeq]);

  useSearchDismissal(searchQuery, searchFocused, setSearchDismissed, setSearchFocused);

  function updateConversationPreference(
    conversationId: string,
    key: keyof ConversationPreference,
    value: boolean,
  ): void {
    const pushToast = sourceToastPush(
      conversationNotificationSource(conversations.find((row) => row.id === conversationId)),
    );
    if (key === 'pinned' && conversationId.startsWith('merged:')) {
      if (!messageScope || currentAccountScope() !== messageScope) {
        pushToast({ tone: 'error', title: '账号状态未就绪，请稍后重试置顶' });
        return;
      }
      void patchAccountRecords('pins', { [conversationId]: value }).catch((error) => {
        if (messageScopeRef.current !== messageScope) return;
        pushToast({
          tone: 'error',
          title: '聚合入口置顶状态保存失败',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (key === 'pinned' && !conversationId.startsWith('virtual:')) {
      const conversation =
        conversations.find((row) => row.id === conversationId) ??
        hiddenConversationsById.get(conversationId) ??
        contactDirectoryConversations.find((row) => row.id === conversationId);
      const target = conversationRoamingTarget(conversation);
      if (!target) {
        pushToast({ tone: 'error', title: '该会话没有可用的 QQ 置顶目标' });
        return;
      }
      if (!pinSession.available || pinSession.busy) {
        pushToast({
          tone: 'info',
          durationKind: pinSession.busy ? 'success' : 'failure',
          title: pinSession.busy ? '请等待当前置顶操作完成' : 'QQ 在线能力未就绪，未改变置顶状态',
        });
        return;
      }
      void pinSession.run(
        (binding) =>
          pinMutation.mutateAsync({
            ...binding,
            target:
              target.kind === 'group'
                ? { kind: 'group', groupId: Number(target.conv) }
                : { kind: 'c2c', uid: target.conv },
            enabled: value,
          }),
        undefined,
        {
          backgroundRefresh: true,
          readbackSuccessText: value ? '已置顶' : '已取消置顶',
          source: conversationNotificationSource(conversation),
          readback: async () => {
            const result = await topContacts.refetch();
            if (result.error) throw result.error;
            return result.data?.some((row) => row.targetId === conversationId) === value;
          },
        },
      );
      return;
    }
    setConversationPrefs((current) => ({
      ...current,
      [conversationId]: {
        ...fallbackPreference,
        ...conversations.find((conversation) => conversation.id === conversationId)?.preference,
        ...current[conversationId],
        [key]: value,
      },
    }));
  }

  /**
   * 从表情面板目录里抽出「能按超级表情发」的 faceId → packId/stickerId。
   *
   * 面板 overview 的形状随分组嵌套，这里不写死结构：递归扫出带 `sticker===true`
   * 且 `id/packId/stickerId` 齐全的项。`(packId, stickerId)` 不唯一，所以键必须是
   * faceId（`id`）。
   */
  function collectSuperStickers(value: unknown, out: Map<string, ComposerSuperSticker>): void {
    if (Array.isArray(value)) {
      for (const item of value) collectSuperStickers(item, out);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (
      record.sticker === true &&
      typeof record.id === 'string' &&
      typeof record.packId === 'string' &&
      record.packId &&
      typeof record.stickerId === 'string' &&
      record.stickerId
    ) {
      out.set(record.id, {
        packId: record.packId,
        stickerId: record.stickerId,
        ...(typeof record.desc === 'string' ? { desc: record.desc } : {}),
        ...(typeof record.stickerType === 'number' ? { stickerType: record.stickerType } : {}),
      });
    }
    for (const child of Object.values(record)) collectSuperStickers(child, out);
  }

  /**
   * 发消息（输入框主链路）。
   *
   * `body` 是输入框序列化正文（文本 / @ / 引用 / 表情 / 图片 / 视频 / 语音 / 文件 /
   * 弹射表情 / AI 声聊… 都可能在里面），`locals` 是其中媒体 / 文件的本地句柄。
   * 这里把它翻成协议元素（见 {@link buildComposerSendPlan}）再分派 IPC：
   *   - `elements` → `account.sendElements`（媒体在服务层真实上传）；
   *   - `file`     → `account.sendFile`（独立文件管线，需要本机路径）；
   *   - `aiVoice`  → `account.sendAiVoice`（0x929b_0，合成即发送，仅群聊）。
   *
   * 失败一律抛错，服务端拒绝也不算成功。输入区在提交时交接内容；失败消息保留
   * 原稿与重新编辑入口，不自动回填或覆盖下一条草稿。
   */
  const repeatContext = useRef<string | null>(selectedConversation?.id ?? null);
  const [forwardBatch, setForwardBatch] = useState<{
    account: string;
    configId?: string;
    messages: Message[];
    conversation?: Conversation;
  } | null>(null);
  const openSequentialForward = (messages: Message[], conversation?: Conversation) => {
    const prepared = partitionForwardMessages(messages);
    if (!prepared.sendable.length) {
      pushToast({
        tone: 'warning',
        title: '没有可转发的消息',
        detail: prepared.ignored[0]?.reason,
      });
      return;
    }
    setForwardBatch({
      account: user.identityValue,
      configId,
      messages: structuredClone(messages),
      conversation,
    });
  };
  const openForwardTarget = (target: MfTarget) => {
    if (useViewState.getState().openedUin !== user.identityValue) {
      pushToast({
        tone: 'warning',
        durationKind: 'success',
        message: '请先切回转发时的账号再打开对话',
        source: notificationSource(
          { kind: 'app', target: { kind: 'view', view: 'home' } },
          '查看账号与来源',
          null,
        ),
      });
      return;
    }
    shell.openConversation(target.id);
  };
  repeatContext.current = selectedConversation?.id ?? null;
  useEffect(() => {
    repeatContext.current = selectedConversation?.id ?? null;
    return () => {
      repeatContext.current = null;
    };
  }, [selectedConversation?.id]);

  async function repeatMessage(message: Message, conversation: Conversation): Promise<void> {
    const context = conversation.id;
    if (repeatContext.current !== context) throw new Error('会话已切换，未发送。');
    const elements = (message as Message & { qqElements?: RepeatElement[] }).qqElements ?? [];
    await sendMessage(messageBody(elements), undefined, {
      elements,
      plan: () =>
        prepareRepeatPlan(
          elements,
          conversation,
          message.createdAt,
          () => repeatContext.current === context,
        ),
    });
  }

  async function prepareRepeatPlan(
    source: RepeatElement[],
    conversation: Conversation,
    createdAt: string,
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ) {
    const elements = await resolveMentions(source, conversation, isCurrent);
    const stickers = new Map<string, ComposerSuperSticker>();
    if (repeatNeedsStickerCatalog(elements))
      collectSuperStickers(await client.account.emojiPanel.overview.query(), stickers);
    const images = await repeatImageSources(elements, Date.parse(createdAt), signal);
    if (!isCurrent()) throw new Error('账号或会话已切换，未发送');
    return repeatSendPlan(elements, stickers, conversation.type === 'group', images);
  }

  async function resolveMentions(
    elements: RepeatElement[],
    conversation: Conversation,
    isCurrent = () => repeatContext.current === conversation.id,
  ): Promise<RepeatElement[]> {
    const members =
      selectedConversation?.id === conversation.id ? currentGroupMembers : conversation.members;
    const people: MentionIdentity[] = members.map((member) => ({
      uid: member.id,
      uin: member.identityValue,
      nick: member.nick,
    }));
    people.push({
      uid: user.uid ?? user.id,
      uin: user.identityValue,
      nick: selfProfile.data?.nick,
    });
    for (const [uid, profile] of profileByUid)
      if (!people.some((person) => person.uid === uid))
        people.push({
          uid,
          uin: String(profile.uin ?? ''),
          nick: profile.nick,
        });
    const uids = new Set<string>();
    const uins = new Set<string>();
    const groupUids = new Set(members.map((member) => member.id));
    const visit = (list: RepeatElement[]) => {
      for (const element of list) {
        const data = element.data ?? {};
        if (element.type === 'at') {
          const uid = String(data.atTargetUid ?? '');
          const uin = String(data.atTargetUin ?? '');
          if (
            uid &&
            uid !== 'all' &&
            (conversation.type === 'group'
              ? !groupUids.has(uid)
              : !people.some((person) => person.uid === uid))
          )
            uids.add(uid);
          else if (!uid && /^\d+$/.test(uin)) uins.add(uin);
        }
        if (Array.isArray(data.origElements)) visit(data.origElements);
      }
    };
    visit(elements);
    if (conversation.type === 'group') {
      const ids = [...uids];
      const numbers = [...uins];
      for (let offset = 0; offset < Math.max(ids.length, numbers.length); offset += 200) {
        if (!isCurrent()) throw new Error('会话已切换，未继续解析提及。');
        const rows = [
          ...(ids.slice(offset, offset + 200).length
            ? await client.account.getGroupMembersByUids.query({
                groupCode: conversation.id,
                uids: ids.slice(offset, offset + 200),
              })
            : []),
          ...(numbers.slice(offset, offset + 200).length
            ? await client.account.getGroupMembersByUins.query({
                groupCode: conversation.id,
                uins: numbers.slice(offset, offset + 200),
              })
            : []),
        ];
        for (const row of rows) {
          const member = mapGroupMemberWire(row);
          people.unshift({
            uid: member.id,
            uin: member.identityValue,
            nick: member.nick,
          });
        }
      }
    }
    if (!isCurrent()) throw new Error('会话已切换，未继续解析提及。');
    return resolveMentionLabels(elements, people);
  }

  async function forwardMessage(
    message: Message,
    target: MfTarget,
    signal: AbortSignal,
    account = forwardBatch?.account,
    expectedAccountConfigId?: string,
  ) {
    const isCurrent = () => !signal.aborted && account === useViewState.getState().openedUin;
    if (!isCurrent()) throw new Error('账号已切换或转发已停止');
    const reason = forwardMessageBlockReason(message);
    if (reason) throw new Error(reason);
    const destination = conversations.find((item) => item.id === target.id);
    if (!destination || destination.type === 'merged') throw new Error('目标会话已不存在');
    // 引用指针属于来源会话，不能指向目标会话中同序号的另一条消息。
    const source = (
      (message as Message & { qqElements?: RepeatElement[] }).qqElements ?? []
    ).filter((element) => element.type !== 'reply');
    await sendMessage(
      messageBody(source),
      undefined,
      {
        elements: source,
        plan: () => prepareRepeatPlan(source, destination, message.createdAt, isCurrent, signal),
      },
      destination,
      isCurrent,
      expectedAccountConfigId,
    );
  }

  async function sendComposerMessage(body: string, locals?: LocalMediaRef[]): Promise<void> {
    const conversation = selectedConversation;
    if (!conversation) return;
    const account = openedUin;
    const scope = messageScopeRef.current;
    const submission: ComposerSubmission = {
      id: `optimistic-${mfId('msg')}`,
      draft: { body, locals },
      started: false,
      accepted: false,
      afterSeq: outgoingAfterSeq(conversation?.id),
      at: Date.now(),
    };
    let render = { body: '消息未发送', elements: [] as unknown[] };
    try {
      render = buildOptimisticRender({ body, locals: locals ?? [], superStickers: new Map() });
    } catch {
      // 原稿仍交给发送计划校验，失败时保留编辑和重试入口。
    }
    const isCurrent = () =>
      useViewState.getState().openedUin === account && messageScopeRef.current === scope;
    setOptimisticMessages((current) => [
      ...current,
      {
        id: submission.id,
        convId: conversation.id,
        afterSeq: submission.afterSeq,
        ...render,
        composerDraft: submission.draft,
        state: 'queued',
        at: submission.at ?? Date.now(),
      },
    ]);
    outgoingQueue.current.add(submission.id, conversation.id, async () => {
      setOptimisticMessages((current) =>
        current.map((item) =>
          item.id === submission.id
            ? { ...item, state: 'sending', hostReceived: false, error: undefined }
            : item,
        ),
      );
      try {
        await sendMessage(body, locals, undefined, conversation, isCurrent, undefined, submission);
      } catch (error) {
        setOptimisticMessages((current) =>
          current.map((item) =>
            item.id === submission.id && !item.seqRejected
              ? {
                  ...item,
                  state: 'failed',
                  error: error instanceof Error ? error.message : String(error),
                }
              : item,
          ),
        );
        throw error;
      }
    });
  }

  async function sendMessage(
    body: string,
    locals?: LocalMediaRef[],
    repeated?: {
      plan: ComposerSendPlan | (() => Promise<ComposerSendPlan>);
      elements: RepeatElement[];
    },
    destination?: Conversation,
    isCurrent = () => repeatContext.current === selectedConversation?.id,
    expectedAccountConfigId = pinSession.binding?.expectedAccountConfigId,
    submission?: ComposerSubmission,
  ): Promise<void> {
    if (!isCurrent()) throw new Error('账号或会话已切换，未发送');
    const conversation = destination ?? selectedConversation;
    const pushToast = sourceToastPush(conversationNotificationSource(conversation));
    if (!conversation) {
      pushToast({ tone: 'warning', durationKind: 'success', message: '没有选中的会话' });
      throw new Error('no conversation');
    }
    if (!sendAccess.data?.qqOnline || !sendAccess.data.attachEnabled) {
      pushToast({
        tone: 'warning',
        message: 'QQ 未在线或处于完全离线模式',
        detail: '发送消息需要在线 QQ 实例，请先登录 QQ 并退出完全离线模式后重试。',
      });
      throw new Error('qq offline');
    }
    const target = sendTargetOf(conversation);
    if (!target) {
      pushToast({
        tone: 'warning',
        message: '这个会话不支持发送消息',
        durationKind: 'success',
        detail: '服务号 / 公众号这类聚合会话不能作为发送目标。',
      });
      throw new Error('unsupported conversation');
    }

    // 所有发送入口均先回显，再准备目录、媒体、提及和网络请求。
    const fileExistingMsgIds = loadedRef.current.map((message) => message.msgId);
    const optimisticId = submission?.id ?? `optimistic-${mfId('msg')}`;
    if (submission) submission.started = true;
    if (!submission) {
      const render = repeated
        ? { body, elements: repeated.elements }
        : buildOptimisticRender({ body, locals: locals ?? [], superStickers: new Map() });
      const pending: OptimisticMessage = {
        id: optimisticId,
        convId: conversation.id,
        afterSeq: outgoingAfterSeq(conversation.id),
        body: render.body,
        elements: render.elements,
        state: 'sending',
        at: Date.now(),
      };
      setOptimisticMessages((current) =>
        current.some((item) => item.id === optimisticId)
          ? current.map((item) => (item.id === optimisticId ? pending : item))
          : [...current, pending],
      );
    }
    const patchOptimistic = (next: Partial<OptimisticMessage>): void => {
      setOptimisticMessages((current) =>
        current.map((item) => (item.id === optimisticId ? { ...item, ...next } : item)),
      );
    };

    let plan: ComposerSendPlan;
    let transferId: string | undefined;
    const reportToHost = (received: number, total: number) => {
      if (transferId && isCurrent())
        transferActivity?.setLocal(transferId, { phase: 'to-host', received, total });
    };
    let outcome: {
      ok: boolean;
      result?: number;
      errMsg?: string;
      hint?: string;
      groupSequence?: number;
      privateSequence?: number;
      random?: number;
    };
    try {
      const superStickers = new Map<string, ComposerSuperSticker>();
      if (composerNeedsStickerCatalog(body)) {
        try {
          collectSuperStickers(await client.account.emojiPanel.overview.query(), superStickers);
        } catch {
          // 原发送计划负责报告缺少目录，不静默降级超级表情。
        }
      }
      locals = await resolveComposerMedia(body, locals);
      plan = repeated
        ? typeof repeated.plan === 'function'
          ? await repeated.plan()
          : repeated.plan
        : buildComposerSendPlan({ body, locals: locals ?? [], superStickers });
      if (
        plan.kind === 'file' ||
        (plan.kind === 'elements' &&
          plan.elements.some((element) =>
            ['image', 'video', 'bubbleVideo', 'flashPhoto'].includes(
              String((element as { kind?: string })?.kind),
            ),
          ))
      ) {
        transferId = newOutgoingRequestId();
        patchOptimistic({ transferId });
      }
      if (plan.kind === 'elements')
        plan.elements = await resolveSendMentions(plan.elements, (elements) =>
          resolveMentions(elements, conversation, isCurrent),
        );
      if (plan.kind === 'file')
        patchOptimistic({ fileSync: { fileId: '', existingMsgIds: fileExistingMsgIds } });
      if (!isCurrent()) throw new Error('账号或会话已切换，未发送');
      // 装扮由消息行异步补齐；发送字体沿用服务端当前账号配置，不为预览增加往返。
      if (plan.kind === 'flashTransfer') {
        outcome = await client.account.forwardFlashTransfer.mutate({
          ...outgoingReceipt(optimisticId),
          expectedAccountUin: user.identityValue,
          ...(expectedAccountConfigId ? { expectedAccountConfigId } : {}),
          peerType: target.peerType,
          targetId: target.targetId,
          ...(target.tempGroupCode ? { tempGroupCode: target.tempGroupCode } : {}),
          fileSetId: plan.fileSetId,
        });
      } else if (plan.kind === 'file') {
        const fileName = plan.fileName;
        if (target.tempGroupCode) {
          // 私聊文件走的是 trans0x211 路由（c2c 专用），临时会话还没验证过对应的文件
          // 管线：与其发一条大概率被拒的 c2c 文件，不如如实说清楚。
          pushToast({
            tone: 'warning',
            message: '群临时会话暂不支持发文件',
            durationKind: 'success',
            detail: '文件走的是私聊专用的 trans0x211 管线，临时会话还没有对应实现。',
          });
          throw new Error('temp session file unsupported');
        }
        const sendFile = (source: { path: string } | { uploadId: string }) =>
          client.account.sendFile.mutate({
            ...outgoingReceipt(optimisticId),
            expectedAccountUin: user.identityValue,
            ...(expectedAccountConfigId ? { expectedAccountConfigId } : {}),
            peerType: target.peerType,
            targetId: target.targetId,
            transferId,
            ...source,
            fileName,
          });
        if (plan.file !== undefined) {
          if (!expectedAccountConfigId) throw new Error('账号来源未就绪，请重新打开会话');
          const staged = await stageAccountFile(
            plan.file,
            {
              expectedAccountUin: user.identityValue,
              expectedAccountConfigId,
            },
            undefined,
            reportToHost,
          );
          if (!isCurrent()) throw new Error('账号或会话已切换，未发送文件');
          outcome = await sendFile({ path: staged.path });
        } else if (plan.path !== undefined) outcome = await sendFile({ path: plan.path });
        else {
          if (!expectedAccountConfigId) throw new Error('账号来源未就绪，请重新打开会话');
          outcome = await withBrowserFile(
            client.account,
            {
              expectedAccountUin: user.identityValue,
              expectedAccountConfigId,
            },
            plan.bytes,
            isCurrent,
            (uploadId) => sendFile({ uploadId }),
            reportToHost,
          );
        }
      } else if (plan.kind === 'voice') {
        // 录音是 webm/opus，主进程只收 WAV/SILK：先在渲染层解成 24k WAV。
        const wav = await decodeRecordingToWav(plan.recording);
        outcome = await client.account.sendVoice.mutate({
          ...outgoingReceipt(optimisticId),
          peerType: target.peerType,
          targetId: target.targetId,
          ...(target.tempGroupCode ? { tempGroupCode: target.tempGroupCode } : {}),
          wav: toIpcElements([wav])[0],
          ...(plan.durationSec ? { durationSec: plan.durationSec } : {}),
          ...(plan.voiceChanged ? { voiceChanged: true } : {}),
          fileName: plan.fileName,
        });
      } else if (plan.kind === 'aiVoice') {
        if (target.peerType !== 'group') {
          pushToast({
            tone: 'warning',
            message: 'AI 声聊只支持群聊',
            durationKind: 'success',
            detail: '私聊没有这个能力，内容已为你保留在输入框里。',
          });
          throw new Error('ai voice requires group');
        }
        outcome = await client.account.sendAiVoice.mutate({
          ...outgoingReceipt(optimisticId),
          groupId: target.targetId,
          voiceId: plan.voiceId,
          text: plan.text,
        });
      } else {
        outcome = await client.account.sendElements.mutate({
          ...outgoingReceipt(optimisticId),
          expectedAccountUin: user.identityValue,
          ...(expectedAccountConfigId ? { expectedAccountConfigId } : {}),
          peerType: target.peerType,
          targetId: target.targetId,
          ...(target.tempGroupCode ? { tempGroupCode: target.tempGroupCode } : {}),
          elements: toIpcElements(plan.elements),
          transferId,
        });
      }
    } catch (error) {
      const reason = composerSendError(error);
      patchOptimistic({ state: 'failed', error: reason });
      pushToast({
        tone: 'error',
        message: '发送失败',
        detail: reason,
      });
      throw error;
    } finally {
      if (transferId) transferActivity?.setLocal(transferId);
    }

    // 服务端明确拒绝（result≠0）不抛传输异常，只能靠回执判断 —— 不把「调用了」当「发成功」。
    if (!outcome.ok) {
      const reason = outcome.errMsg || outcome.hint || '服务端拒绝了这条消息';
      patchOptimistic({ state: 'failed', error: reason });
      pushToast({ tone: 'error', message: '发送失败', detail: reason });
      throw new Error(reason);
    }

    if (submission) submission.accepted = true;
    if (outcome.hint?.includes('本地保存失败')) {
      pushToast({
        tone: 'warning',
        message: '消息已发送，本地保存失败',
        detail: '请勿重复发送；可稍后通过漫游拉取补回。',
      });
    }

    // 回执里的 random / seq 用来对账与排序（与 Ark 同）。文件回执只有 random /
    // privateSequence，AI 声聊回执两者都没有，所以分类处理。
    if (plan.kind === 'file') {
      const fileOutcome = outcome as Awaited<ReturnType<typeof client.account.sendFile.mutate>>;
      if (!IS_WEB) void utils.account.mediaResource.messageLocations.invalidate();
      patchOptimistic({
        fileSync: { fileId: fileOutcome.fileId, existingMsgIds: fileExistingMsgIds },
        ...expectedKeysOf({
          peerType: target.peerType,
          targetId: target.targetId,
          ok: fileOutcome.ok,
          ...(fileOutcome.result !== undefined ? { result: fileOutcome.result } : {}),
          ...(fileOutcome.privateSequence !== undefined
            ? { privateSequence: fileOutcome.privateSequence }
            : {}),
          ...(fileOutcome.random !== undefined ? { random: fileOutcome.random } : {}),
        }),
        state: 'sent',
      });
      return;
    }
    if (plan.kind === 'aiVoice' || plan.kind === 'flashTransfer') {
      // 两者均由服务端生成消息，没有 PbSendMsg 的 random / seq，不伪造普通消息对账。
      patchOptimistic({
        state: 'sent',
        generatedExistingMsgIds: fileExistingMsgIds,
        signatures: [plan.kind === 'aiVoice' ? `aiVoice:${plan.text}` : `flash:${plan.fileSetId}`],
      });
      return;
    }
    patchOptimistic({
      ...expectedKeysOf({
        peerType: target.peerType,
        targetId: target.targetId,
        ok: outcome.ok,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        ...(outcome.groupSequence !== undefined ? { groupSequence: outcome.groupSequence } : {}),
        ...(outcome.privateSequence !== undefined
          ? { privateSequence: outcome.privateSequence }
          : {}),
        ...(outcome.random !== undefined ? { random: outcome.random } : {}),
      }),
      state: 'sent',
    });
    if (isSeqRejected({ ...outcome, peerType: target.peerType, targetId: target.targetId })) {
      pushToast({
        tone: 'warning',
        message: '这条消息可能未被服务端接收',
        detail: '服务端回了成功但没有分配消息序号，这通常意味着它静默丢弃了这条。请让对方确认。',
      });
      throw new Error('服务端未分配消息序号，未确认发送成功');
    }
  }

  /**
   * 发起语音通话。
   *
   * 只有私聊：群通话要先进群房间再邀请（OIDB 4752/4753/4754），与私聊不是同一条
   * 协议路径。通话界面使用独立系统窗口，挂断 / 结束由窗口自己收尾。
   */
  async function startVoiceCall(
    conversation: Extract<Conversation, { type: 'direct' }>,
    media: 'audio' | 'video' = 'audio',
  ) {
    const pushToast = sourceToastPush(conversationNotificationSource(conversation));
    if (!sendAccess.data?.qqOnline || !sendAccess.data.attachEnabled) {
      pushToast({
        tone: 'warning',
        message: 'QQ 未在线或处于完全离线模式',
        detail: '通话需要借用在线 QQ 实例的凭据，请先登录 QQ 并退出完全离线模式。',
      });
      throw new Error('qq offline');
    }

    const other = conversation.otherUser;
    const peerUin = /^\d+$/.test(other.identityValue) ? other.identityValue : other.id;
    try {
      const call = await client.call.start.mutate({
        peerUin,
        peerName: other.displayName || other.username || peerUin,
        peerAvatar: other.avatarUrl ?? undefined,
        media,
      });
      setActiveCall(call as never);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      pushToast({ tone: 'error', message: '无法发起通话', detail: reason });
      throw error;
    }
  }

  /**
   * 位置卡片要用的地理能力：地点搜索 + 逆地址解析，都走主进程的腾讯位置服务
   * （渲染层 CSP 是 `connect-src 'self'`，而且 key 不该落进前端）。
   *
   * IPC 返回的形状与模板层的 `ArkPlaceSuggestion` / `ArkResolvedAddress` 结构一致，
   * 所以这里直接透传，不做二次搬运。
   */
  const arkLocation = useMemo<ArkLocationProvider>(
    () => ({
      suggest: (keyword, center) =>
        client.account.lbsSuggestPlaces.query({
          keyword,
          latitude: center.latitude,
          longitude: center.longitude,
        }),
      reverse: (latitude, longitude) =>
        client.account.lbsReverseGeocode.query({ latitude, longitude }),
    }),
    [],
  );

  /**
   * Ark 面板「推荐好友 / 推荐群」的可选项：把已经查好的好友（`buddies` + `profiles`
   * 补昵称/备注）与全部群（`allGroups`）拍平成面板能直接过滤的列表。
   *
   * 面板自己不碰 trpc（与 `arkLocation` 同一约定），所以这里只交数据、不做增量拉取：
   * 好友上限 2000、群上限 2000，已经是主界面会话列表用的同一批数据。
   */
  const arkContacts = useMemo<ArkContactSource>(() => {
    const profileByUid = new Map(
      (profiles.data ?? []).map((profile) => [profile.uid, profile] as const),
    );
    const friends = (buddies.data ?? []).map((buddy) => {
      const profile = profileByUid.get(buddy.uid);
      return {
        // 发给服务端的是 QQ 号（纯数字）；uid 只有当好友列表里没号时才退化使用。
        id: buddy.uin,
        name: (profile?.remark || profile?.nick || '').trim() || buddy.uin,
        sub: `QQ ${buddy.uin}`,
        avatarUrl: cachedAvatarUrl(avatarFromUin(buddy.uin, 100) ?? undefined) ?? undefined,
      };
    });
    const groups = (allGroups.data ?? []).map((group) => ({
      id: group.groupCode,
      name: (group.remark || group.groupName || '').trim() || group.groupCode,
      sub: group.memberCount ? `${group.memberCount} 人` : '群聊',
      avatarUrl:
        cachedAvatarUrl(avatarFromGroupCode(group.groupCode, 100) ?? undefined) ?? undefined,
    }));
    return { friends, groups };
  }, [buddies.data, profiles.data, allGroups.data]);

  /**
   * 闪传文件框「发送」—— 面板给一组本地文件 + 封面，这里补上目标会话走 IPC。
   *
   * 与 Ark 卡片同一套：先插一条**乐观渲染**的闪传卡片（走真消息同一条渲染通路，
   * 见 `buildFlashOptimisticElement`），再发。flash 的回执不给 seq（0x93d7 只回显目标），
   * 所以对账靠**签名**：发出后拿到 `filesetUuid` + `shareUrl`，真消息回来时要么带
   * `flashTransferInfo.fileSetId`（Win / 安卓的真卡片），要么是被降级成纯文本的分享
   * 短码（Linux / 鸿蒙）—— 两条签名扫到任一条就把乐观条目收掉（见上面对账 effect）。
   */
  /**
   * 闪照「选图即发」。
   *
   * 协议上闪照是一条普通消息，只是元素换成 `flashPhoto`（老式图片上传 +
   * `commonElem{serviceType:3}` + 兜底文本），所以直接复用 `sendElements`：
   * 服务层看到 `flashPhoto` 就会带上传上下文（`elementsNeedUpload`）。
   *
   * 乐观渲染：先按**本地图片**画一条闪照气泡（`pic` + `isFlash` + `localPreviewUrl`），
   * 上传完拿到服务端签发的 offpic 路径后再换成真图（`localPath` 换成服务端 token，
   * 见 `flashPhotoOptimisticElement`）。对账走回执里的 `random` —— 与其它消息同一条
   * 链路（`expectedKeysOf`），所以同步到位后不会重影。
   */
  async function sendFlashPhoto(
    conversation: Conversation,
    payload: FlashPhotoSendPayload,
  ): Promise<void> {
    const scope = messageScopeRef.current;
    const expectedAccountConfigId = pinSession.binding?.expectedAccountConfigId;
    const pushToast = sourceToastPush(conversationNotificationSource(conversation));
    if (!sendAccess.data?.qqOnline || !sendAccess.data.attachEnabled) {
      pushToast({
        tone: 'warning',
        message: 'QQ 未在线或处于完全离线模式',
        detail: '发送闪照需要在线 QQ 实例，请先登录 QQ 并退出完全离线模式后重试。',
      });
      throw new Error('qq offline');
    }
    const target = sendTargetOf(conversation);
    if (!target) {
      pushToast({
        tone: 'warning',
        message: '这个会话不支持发送闪照',
        durationKind: 'success',
        detail: '服务号 / 公众号这类聚合会话不能作为发送目标。',
      });
      throw new Error('unsupported conversation');
    }
    if (target.tempGroupCode) {
      // 闪照走老式图片上传 + c2c 路由，临时会话这条还没验过。
      pushToast({
        tone: 'warning',
        message: '群临时会话暂不支持发闪照',
        durationKind: 'success',
        detail: '闪照的老式图片上传还没有对应的临时会话实现。',
      });
      throw new Error('temp session flash photo unsupported');
    }
    // 乐观气泡：先拿本地字节画一张预览图（与真实闪照气泡同形），上传完成后再换真图。
    const previewUrl = URL.createObjectURL(
      payload.file ??
        new Blob([new Uint8Array(payload.bytes ?? new Uint8Array(0))], {
          type: 'image/*',
        }),
    );
    const optimisticId = `optimistic-${mfId('flp')}`;
    const transferId = newOutgoingRequestId();
    const optimisticElement = (url: string, name: string): unknown => ({
      type: 'pic',
      data: {
        fileName: name,
        // 闪照在渲染层靠 `isFlash` + `localPreviewUrl` 直接显示本地预览；
        // 服务端 token 回来之前 `fileToken` 留空（`flashPicUrl` 会返回 null）。
        isFlash: true,
        imgWidth: 0,
        imgHeight: 0,
        summary: ['[闪照]'],
        localPreviewUrl: url,
      },
    });
    setOptimisticMessages((current) => [
      ...current,
      {
        id: optimisticId,
        transferId,
        convId: conversation.id,
        body: FLASH_PHOTO_PLACEHOLDER_TEXT,
        afterSeq: outgoingAfterSeq(conversation.id),
        elements: [optimisticElement(previewUrl, payload.name)],
        state: 'sending',
        at: Date.now(),
      },
    ]);
    const patchOptimistic = (next: Partial<OptimisticMessage>): void =>
      setOptimisticMessages((current) =>
        current.map((item) => (item.id === optimisticId ? { ...item, ...next } : item)),
      );
    try {
      const source = payload.file
        ? new Uint8Array(await payload.file.arrayBuffer())
        : (payload.bytes ?? payload.path);
      if (source instanceof Uint8Array && source.length === 0)
        throw new Error('图片是空的，无法发送闪照。');
      if (messageScopeRef.current !== scope) throw new Error('账号数据源已切换，未发送闪照');
      const outcome = await client.account.sendElements.mutate({
        ...outgoingReceipt(optimisticId),
        expectedAccountUin: user.identityValue,
        expectedAccountConfigId,
        transferId,
        peerType: target.peerType,
        targetId: target.targetId,
        elements: toIpcElements([
          {
            kind: 'flashPhoto',
            source,
          },
        ]),
      });
      if (!outcome.ok) {
        const reason = outcome.errMsg || outcome.hint || '服务端拒绝了这条闪照';
        patchOptimistic({ state: 'failed', error: reason });
        throw new Error(reason);
      }
      patchOptimistic({
        ...expectedKeysOf({
          peerType: target.peerType,
          ...(outcome.groupSequence !== undefined ? { groupSequence: outcome.groupSequence } : {}),
          ...(outcome.privateSequence !== undefined
            ? { privateSequence: outcome.privateSequence }
            : {}),
          ...(outcome.random !== undefined ? { random: outcome.random } : {}),
        }),
        state: 'sent',
      });
      if (isSeqRejected({ ...outcome, peerType: target.peerType, targetId: target.targetId })) {
        pushToast({
          tone: 'warning',
          message: '这条闪照可能未被服务端接收',
          detail: '服务端回了成功但没有分配消息序号，这通常意味着它静默丢弃了这条。',
        });
      }
    } catch (error) {
      patchOptimistic({
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      pushToast({
        tone: 'error',
        message: '发送失败',
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      // blob 由乐观条目持有：真消息回来后整条被收掉，届时统一释放。
      // 这里不释放 —— 提前 revoke 会让气泡里的预览图当场裂开。
      optimisticBlobs.current.set(optimisticId, previewUrl);
    }
  }

  /**
   * 泡泡消息「选视频即发」。
   *
   * 协议上它就是一条视频消息，只是 `commonElem.businessType=14` 且 `pbElem.extBizInfo`
   * 里带模板名（见 `@weqbot/protocol` 的 `SendBubbleVideoElement`），所以复用
   * `sendElements`；服务层看到 `bubbleVideo` 会带上媒体上传上下文。
   *
   * 乐观渲染按 `bubbleVideo` 画圆形循环预览（与真消息同一条渲染通路），对账走回执
   * 里的 `random`。
   */
  async function sendBubbleVideo(
    conversation: Conversation,
    payload: BubbleVideoSendPayload,
  ): Promise<void> {
    const scope = messageScopeRef.current;
    const expectedAccountConfigId = pinSession.binding?.expectedAccountConfigId;
    const pushToast = sourceToastPush(conversationNotificationSource(conversation));
    if (!sendAccess.data?.qqOnline || !sendAccess.data.attachEnabled) {
      pushToast({
        tone: 'warning',
        message: 'QQ 未在线或处于完全离线模式',
        detail: '发送泡泡消息需要在线 QQ 实例，请先登录 QQ 并退出完全离线模式后重试。',
      });
      throw new Error('qq offline');
    }
    const target = sendTargetOf(conversation);
    if (!target) {
      pushToast({
        tone: 'warning',
        message: '这个会话不支持发送泡泡消息',
        durationKind: 'success',
        detail: '服务号 / 公众号这类聚合会话不能作为发送目标。',
      });
      throw new Error('unsupported conversation');
    }
    if (target.tempGroupCode) {
      pushToast({
        tone: 'warning',
        message: '群临时会话暂不支持发泡泡消息',
        durationKind: 'success',
        detail: '泡泡走 NTV2 视频上传，临时会话这条还没验过。',
      });
      throw new Error('temp session bubble unsupported');
    }

    const bytes = new Uint8Array(payload.bytes ?? new Uint8Array(0));
    const previewUrl = URL.createObjectURL(
      payload.file ?? new Blob([bytes], { type: 'video/mp4' }),
    );
    const optimisticId = `optimistic-${mfId('bub')}`;
    setOptimisticMessages((current) => [
      ...current,
      {
        id: optimisticId,
        convId: conversation.id,
        body: '[泡泡消息]',
        afterSeq: outgoingAfterSeq(conversation.id),
        elements: [
          {
            type: 'bubbleVideo',
            data: {
              fileName: payload.name,
              videoWidth: payload.width ?? 0,
              videoHeight: payload.height ?? 0,
              videoDuration: payload.duration ?? 0,
              ...(payload.templateName ? { templateName: payload.templateName } : {}),
              localPreviewUrl: previewUrl,
            },
          },
        ],
        state: 'sending',
        at: Date.now(),
      },
    ]);
    const patchOptimistic = (next: Partial<OptimisticMessage>): void =>
      setOptimisticMessages((current) =>
        current.map((item) => (item.id === optimisticId ? { ...item, ...next } : item)),
      );
    try {
      const source = payload.file
        ? new Uint8Array(await payload.file.arrayBuffer())
        : (payload.bytes ?? payload.path);
      if (source instanceof Uint8Array && source.length === 0)
        throw new Error('视频是空的，无法发送泡泡消息。');
      const meta = payload.file ? await readVideoMeta(previewUrl) : payload;
      if (messageScopeRef.current !== scope) throw new Error('账号数据源已切换，未发送泡泡消息');
      const outcome = await client.account.sendElements.mutate({
        ...outgoingReceipt(optimisticId),
        expectedAccountUin: user.identityValue,
        expectedAccountConfigId,
        peerType: target.peerType,
        targetId: target.targetId,
        elements: toIpcElements([
          {
            kind: 'bubbleVideo',
            source,
            ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
            ...(meta.width !== undefined ? { width: meta.width } : {}),
            ...(meta.height !== undefined ? { height: meta.height } : {}),
            fileName: payload.name,
            ...(payload.templateName ? { templateName: payload.templateName } : {}),
          },
        ]),
      });
      if (!outcome.ok) {
        const reason = outcome.errMsg || outcome.hint || '服务端拒绝了这条泡泡消息';
        patchOptimistic({ state: 'failed', error: reason });
        throw new Error(reason);
      }
      patchOptimistic({
        ...expectedKeysOf({
          peerType: target.peerType,
          ...(outcome.groupSequence !== undefined ? { groupSequence: outcome.groupSequence } : {}),
          ...(outcome.privateSequence !== undefined
            ? { privateSequence: outcome.privateSequence }
            : {}),
          ...(outcome.random !== undefined ? { random: outcome.random } : {}),
        }),
        state: 'sent',
      });
      if (isSeqRejected({ ...outcome, peerType: target.peerType, targetId: target.targetId })) {
        pushToast({
          tone: 'warning',
          message: '这条泡泡消息可能未被服务端接收',
          detail: '服务端回了成功但没有分配消息序号，这通常意味着它静默丢弃了这条。',
        });
      }
    } catch (error) {
      patchOptimistic({
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      pushToast({
        tone: 'error',
        message: '发送失败',
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      optimisticBlobs.current.set(optimisticId, previewUrl);
    }
  }

  async function sendFlashTransfer(
    conversation: Conversation,
    payload: FlashSendPayload,
  ): Promise<void> {
    const pushToast = sourceToastPush(conversationNotificationSource(conversation));
    if (!sendAccess.data?.qqOnline || !sendAccess.data.attachEnabled) {
      pushToast({
        tone: 'warning',
        message: 'QQ 未在线或处于完全离线模式',
        detail: '闪传需要在线 QQ 实例，请先登录 QQ 并退出完全离线模式后重试。',
      });
      throw new Error('qq offline');
    }
    const target = sendTargetOf(conversation);
    if (!target) {
      pushToast({
        tone: 'warning',
        message: '这个会话不支持发送闪传',
        durationKind: 'success',
        detail: '服务号 / 公众号这类聚合会话不能作为发送目标。',
      });
      throw new Error('unsupported conversation');
    }

    const first = payload.files[0];
    const title =
      payload.name.trim() ||
      (payload.files.length === 1 && first
        ? first.name
        : `${first?.name ?? '文件'}等${payload.files.length}个文件`);
    const fileBytes = payload.files.reduce((sum, file) => sum + (file.size || 0), 0);
    const desc = flashDescOf(payload.files);
    const coverUrl = payload.coverDataUrl || undefined;

    const optimisticId = `optimistic-${mfId('fl')}`;
    setOptimisticMessages((current) => [
      ...current,
      {
        id: optimisticId,
        convId: conversation.id,
        body: `[QQ闪传] ${title}`,
        generatedExistingMsgIds: loadedRef.current.map((message) => message.msgId),
        afterSeq: outgoingAfterSeq(conversation.id),
        elements: [
          buildFlashOptimisticElement({
            title,
            desc,
            ...(coverUrl ? { coverUrl } : {}),
            fileBytes,
          }),
        ],
        state: 'sending',
        at: Date.now(),
      },
    ]);
    const patchOptimistic = (next: Partial<OptimisticMessage>): void =>
      setOptimisticMessages((current) =>
        current.map((item) => (item.id === optimisticId ? { ...item, ...next } : item)),
      );

    try {
      const result = await client.account.sendFlashTransfer.mutate({
        ...outgoingReceipt(optimisticId),
        peerType: target.peerType,
        targetId: target.targetId,
        files: payload.files.map((file) => ({ path: file.path, name: file.name })),
        ...(payload.name.trim() ? { name: payload.name.trim() } : {}),
        ...(payload.coverDataUrl ? { coverBase64: payload.coverDataUrl } : {}),
      });
      // 给乐观卡片补上 filesetId（自己点开也能看文件），并打上对账签名。
      // Windows / 安卓端回来的真卡片带 filesetUuid；Linux / 鸿蒙端被服务端降级成纯文本，
      // 只剩回执 shareUrl 里的分享短码 —— 两条都登记，哪条先到都能把乐观卡片收掉。
      const shareCode = flashShareCodeOfUrl(result.shareUrl);
      patchOptimistic({
        state: 'sent',
        signatures: [`flash:${result.filesetUuid}`, ...(shareCode ? [`flash:${shareCode}`] : [])],
        elements: [
          buildFlashOptimisticElement({
            title,
            desc,
            ...(coverUrl ? { coverUrl } : {}),
            fileBytes,
            filesetId: result.filesetUuid,
          }),
        ],
      });
    } catch (err) {
      patchOptimistic({
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      pushToast({
        tone: 'error',
        message: '发送失败',
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * 会话 → IPC 的 `{peerType, targetId, tempGroupCode?}`。
   * 聚合会话（服务号 / 公众号 / 隐藏 / 删除）没有可发送的目标，返回 null。
   *
   * 群聊发起的临时会话仍是 c2c 形状，但要多带一个**来源群号** —— 服务层据此改走
   * `routingHead.grpTmp`（见 `MessageSendService` 的 `GroupTempSource`），否则服务端
   * 会把它当成非好友之间的普通私聊拒收。
   */
  /**
   * 红包面板「发红包」—— 面板只收「金额 / 个数 / 是否口令 / 祝福语」，这里补目标会话走
   * IPC 下单出码（`hb_pc_pre_pack`），成功后弹二维码灯箱。
   *
   * **不做乐观渲染**：这一步只是下单出码，不扣钱，真实红包消息要等 QQ 付款后自己同步
   * 回来。在线校验与消息发送按钮同一套。
   */
  async function sendRedPacket(conversation: Conversation, draft: RedPacketDraft): Promise<void> {
    const pushToast = sourceToastPush(conversationNotificationSource(conversation));
    if (!sendAccess.data?.qqOnline || !sendAccess.data.attachEnabled) {
      pushToast({
        tone: 'warning',
        message: 'QQ 未在线或处于完全离线模式',
        detail: '发红包需要在线 QQ 实例，请先登录 QQ 并退出完全离线模式后重试。',
      });
      throw new Error('qq offline');
    }
    const target = sendTargetOf(conversation);
    if (!target) {
      pushToast({
        tone: 'warning',
        message: '这个会话不支持发红包',
        durationKind: 'success',
        detail: '服务号 / 公众号这类聚合会话不能作为发送目标。',
      });
      throw new Error('unsupported conversation');
    }

    // 私聊给 uid（路由器会查 uid→uin），群聊给群号。
    const conv =
      target.peerType === 'group'
        ? target.targetId
        : conversation.type === 'direct'
          ? conversation.otherUser.id
          : target.targetId;

    try {
      const result = await client.account.redbagSend.mutate({
        kind: target.peerType,
        conv,
        totalNum: draft.totalNum,
        totalAmount: draft.totalAmount,
        lucky: draft.lucky,
        ...(draft.password ? { password: draft.password } : {}),
        // 普通红包的祝福语（协议侧与口令共用 f5）；口令红包时 draft.wishing 为 null。
        ...(draft.wishing ? { wishing: draft.wishing } : {}),
      });
      if (result.qrcodeBase64) {
        openRedBagQrcode({
          qrcodeBase64: result.qrcodeBase64,
          lucky: result.lucky,
          password: draft.password !== null,
          totalNum: draft.totalNum,
          totalAmount: draft.totalAmount,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      pushToast({ tone: 'error', title: '红包发送失败', detail: message });
      throw e;
    }
  }

  /**
   * Ark 卡片面板「发送」—— 面板把卡片内容交上来，这里补上**当前会话**的
   * peerType / targetId 再走 IPC。三类载荷对应三条 route：
   *
   *   推荐好友 / 推荐群 → account.sendContactArkCard（服务端取卡 → 发 lightApp 元素）
   *   位置卡片          → account.sendLocationArkCard（trpc LocationArk 裸 SSO）
   *   图文              → account.sendTuwenArk（0xdc2_34 服务端下发，与群反馈的
   *                        GitHub issue/PR 卡片同一条路）
   *   自定义 JSON       → account.sendArkCard（自己拼的 ark JSON → lightApp 元素）
   *
   * 失败一律抛错（面板显示原因并保留已填内容），不把「调用了」当「发成功」。
   */
  async function sendArkCard(conversation: Conversation, payload: ArkPayload): Promise<void> {
    const pushToast = sourceToastPush(conversationNotificationSource(conversation));
    if (!sendAccess.data?.qqOnline || !sendAccess.data.attachEnabled) {
      pushToast({
        tone: 'warning',
        message: 'QQ 未在线或处于完全离线模式',
        detail: '发送卡片需要在线 QQ 实例，请先登录 QQ 并退出完全离线模式后重试。',
      });
      throw new Error('qq offline');
    }

    // 目标会话：群聊给群号，私聊优先给 QQ 号（服务层会顺手补上 uid）。
    const target = sendTargetOf(conversation);
    if (!target) {
      pushToast({
        tone: 'warning',
        message: '这个会话不支持发送卡片',
        durationKind: 'success',
        detail: '服务号 / 公众号这类聚合会话不能作为发送目标。',
      });
      throw new Error('unsupported conversation');
    }

    // ── 乐观卡片 ───────────────────────────────────────────────────────────
    // 与合并转发同一条路子（见 forwardMergeDraft）：发出去之后不等 QQ 同步回来，先在
    // 会话末尾插一张卡片 + 状态标识。只活在前端 state 里，不写库、不落缓存。
    // 位置卡片与自定义 JSON 从一开始就是最终形状；推荐好友 / 推荐群先画一张本地占位
    // 卡，拿到服务端取回的那份 arkJson 后原位替换（所以同步到位时不会跳变）。
    const optimisticId = `optimistic-${mfId('oa')}`;
    const startOptimistic = (arkData: string): void => {
      setOptimisticArks((current) => [
        ...current,
        {
          id: optimisticId,
          convId: conversation.id,
          arkData,
          afterSeq: outgoingAfterSeq(conversation.id),
          signature: arkCardSignature(arkData),
          state: 'sending',
          at: Date.now(),
        },
      ]);
    };
    const patchOptimistic = (next: Partial<OptimisticArk>): void =>
      setOptimisticArks((current) =>
        current.map((item) => (item.id === optimisticId ? { ...item, ...next } : item)),
      );

    try {
      if (payload.type === 'contact') {
        startOptimistic(buildContactPlaceholderArk(payload.kind, payload.contactId));
        const outcome = await client.account.sendContactArkCard.mutate({
          ...outgoingReceipt(optimisticId),
          peerType: target.peerType,
          targetId: target.targetId,
          kind: payload.kind,
          contactId: payload.contactId,
          ...(payload.phoneNumber ? { phoneNumber: payload.phoneNumber } : {}),
        });
        if (!outcome.ok) {
          throw new Error(outcome.hint ?? outcome.errMsg ?? '服务端拒绝了这张卡片');
        }
        // 服务端取回的那份 arkJson 就是它下发的内容：用它替掉占位卡，顺便对齐签名；
        // 同时记下回执给的 random（cid，对账主键）与群聊辅助 seq —— 真消息一回来
        // 就靠它们把乐观卡片收掉。
        patchOptimistic({
          ...(outcome.arkJson
            ? { arkData: outcome.arkJson, signature: arkCardSignature(outcome.arkJson) }
            : {}),
          ...expectedKeysOf(outcome),
          state: 'sent',
        });
        if (isSeqRejected({ ...outcome, peerType: target.peerType, targetId: target.targetId })) {
          pushToast({
            tone: 'warning',
            message: `${payload.kind === 'qq' ? '推荐好友卡片' : '推荐群卡片'}可能未被服务端接收`,
            detail:
              '服务端回了成功但没有分配消息序号，这通常意味着它静默丢弃了这条。' +
              '请让对方确认是否收到；若没有，换一种内容重发。',
          });
          return;
        }
        return;
      }

      if (payload.type === 'signup') {
        // 群报名卡片：服务端按 0x921b_0 的字段生成卡片（与图文同理，客户端拼的 JSON
        // 只是预览 / 乐观卡片）。它**以群号寻址**，与当前会话无关，所以不走 target。
        startOptimistic(
          buildGroupSignupArkJson({
            groupCode: String(payload.groupCode),
            title: payload.title,
            detail: payload.detail,
            deadline: payload.deadline ? String(payload.deadline) : '',
            method: payload.method === 2 ? 'image' : 'direct',
            maxCount: String(payload.maxCount),
            imageUrl: payload.imageUrl ?? '',
          }),
        );
        await client.account.sendGroupSignup.mutate({
          ...outgoingReceipt(optimisticId),
          groupCode: String(payload.groupCode),
          title: payload.title,
          detail: payload.detail,
          ...(payload.deadline ? { deadline: payload.deadline } : {}),
          method: payload.method === 2 ? 'image' : 'direct',
          maxCount: payload.maxCount,
          ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
        });
        // 回执是空 ack（没有 random / seq），乐观卡片只能靠标题签名对账。
        patchOptimistic({ state: 'sent' });
        return;
      }

      if (payload.type === 'location') {
        startOptimistic(buildLocationArkJson(payload));
        const outcome = await client.account.sendLocationArkCard.mutate({
          ...outgoingReceipt(optimisticId),
          peerType: target.peerType,
          targetId: target.targetId,
          address: payload.address,
          region: payload.region,
          latitude: payload.latitude,
          longitude: payload.longitude,
        });
        // 这条 trpc 的回包格式没抓到样本，拿不到 random / seq —— 乐观卡片只能靠
        // 「坐标签名」对账（服务端会重写卡片文案，但经纬度就是我们发出去的那两个数）。
        patchOptimistic({ state: 'sent' });
        // 业务结果无法从回包判定（见服务层 hint），所以如实说明「无法确认结果」，
        // 不给一个「已送达」的假信号。
        pushToast({
          tone: 'info',
          durationKind: 'failure',
          message: '位置卡片请求已发出',
          detail: outcome.hint,
        });
        return;
      }

      if (payload.type === 'tuwen') {
        // 图文卡片：**服务端下发**（0xdc2_34），与群反馈的 GitHub issue/PR 卡片同一条路 ——
        // 不再自己拼一段 `com.tencent.tuwen.lua` 的 ark JSON 当 lightApp 元素发（那样必然
        // 失败）。协议要的是纯数字目标（私聊 = QQ 号，群聊 = 群号）。
        const targetId = target.targetId;
        if (!/^\d+$/.test(targetId)) {
          throw new Error(
            '图文卡片需要纯数字目标：私聊要 QQ 号。当前会话只拿得到 UID，请改用「自定义 JSON」发送。',
          );
        }
        // 乐观卡片：用同一份字段拼出与旧版同形的 news 卡，发出去就有反馈。真卡片由服务端
        // 生成、靠 `tuwen:<jumpUrl>` 签名收掉（见 arkCardSignature）。
        startOptimistic(
          buildTuwenArkJson({
            jumpUrl: payload.jumpUrl,
            title: payload.title,
            desc: payload.desc,
            previewUrl: payload.previewUrl,
          }),
        );
        const outcome = await client.account.sendTuwenArk.mutate({
          ...outgoingReceipt(optimisticId),
          peerType: target.peerType,
          targetId,
          title: payload.title,
          desc: payload.desc,
          jumpUrl: payload.jumpUrl,
          previewUrl: payload.previewUrl,
        });
        if (!outcome.ok) {
          throw new Error(outcome.hint ?? outcome.errMsg ?? '服务端拒绝了这张卡片');
        }
        // 0xdc2_34 的回包没有 random / seq（服务端也不给 message_id），乐观条目只能靠
        // jumpUrl 签名对账，这里只把状态改成已发送。
        patchOptimistic({ state: 'sent' });
        return;
      }

      startOptimistic(payload.arkData);
      const outcome = await client.account.sendArkCard.mutate({
        ...outgoingReceipt(optimisticId),
        peerType: target.peerType,
        targetId: target.targetId,
        arkData: payload.arkData,
      });
      if (!outcome.ok) {
        throw new Error(outcome.hint ?? outcome.errMsg ?? '服务端拒绝了这张卡片');
      }
      patchOptimistic({
        ...expectedKeysOf(outcome),
        state: 'sent',
      });
      if (isSeqRejected({ ...outcome, peerType: target.peerType, targetId: target.targetId })) {
        pushToast({
          tone: 'warning',
          message: '卡片可能未被服务端接收',
          detail:
            '服务端回了成功但没有分配消息序号，这通常意味着它静默丢弃了这条（常见于签名 / 内容不合规）。' +
            '请让对方确认是否收到；若没有，换一种内容重发。',
        });
        return;
      }
    } catch (error) {
      // 失败不删卡：留着那张卡片 + 「发送失败」标识，比一个只闪现几秒的 toast 有用。
      patchOptimistic({
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      pushToast({
        tone: 'error',
        message: '卡片发送失败',
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async function noopAsync(): Promise<void> {
    return undefined;
  }

  // 独占整个内容区、不要左侧列表的视图（含主页）。
  // 数据量大时列表查询耗时明显，侧边栏先用 skeleton 占位。
  const sidebarLoading =
    shell.view === 'messages'
      ? contacts.isLoading && recentContactsData.length === 0
      : shell.view === 'contacts'
        ? shell.contactTab === 'friends'
          ? buddies.isLoading || profiles.isLoading
          : allGroups.isLoading
        : false;

  const fullBleedView =
    shell.view === 'home' ||
    shell.view === 'collections' ||
    shell.view === 'guild-direct' ||
    shell.view === 'qzone' ||
    shell.view === 'mail' ||
    shell.view === 'channel' ||
    shell.view === 'annual';
  const generatedDirectoryOptions = IS_WEB ? regularDirectoryOptions : onlineOptions;
  const directoryPersonas = trpc.account.listAgentLabPersonas.useQuery(
    undefined,
    generatedDirectoryOptions,
  );
  useCloneTaskRefresh();
  const directoryGroups = trpc.account.listAgentLabGroups.useQuery(
    undefined,
    generatedDirectoryOptions,
  );
  const directoryAssistant = trpc.account.listAssistantSessions.useQuery(undefined, {
    ...generatedDirectoryOptions,
    refetchInterval:
      generatedDirectoryOptions.enabled &&
      (conversationView === 'assistant' || conversationView === 'all' || assistantVisited)
        ? 2500
        : false,
  });
  const virtualRows = useMemo(
    () => [
      ...(directoryPersonas.data ?? []).map((item) => ({
        id: `virtual:persona:${item.id}`,
        kind: 'persona' as const,
        ownerId: item.id,
        name: item.name,
        uin: item.sourceUin,
        unreadCount: item.unreadCount,
        directoryRead: item.directoryRead,
        updatedAt: item.updatedAt,
        draftPreview: item.draftPreview,
        ...(item.lastMessageTime ? { lastMessageTime: item.lastMessageTime } : {}),
        ...(item.preview ? { preview: item.preview, previewMine: item.previewMine } : {}),
      })),
      ...(directoryGroups.data ?? []).map((item) => ({
        id: `virtual:group:${item.id}`,
        kind: 'group' as const,
        ownerId: item.id,
        name: item.name,
        updatedAt: item.updatedAt,
        ...(item.lastMessageTime ? { lastMessageTime: item.lastMessageTime } : {}),
        ...(item.preview ? { preview: item.preview, previewMine: item.previewMine } : {}),
        previewSender: item.previewSender,
        draftPreview: item.draftPreview,
        // 九宫格头像用成员源好友的 QQ 号。
        memberUins: item.memberUins,
        unreadCount: item.unreadCount,
        directoryRead: item.directoryRead,
      })),
    ],
    [directoryPersonas.data, directoryGroups.data],
  );
  const [virtualOpen, setVirtualOpen] = useState<{
    kind: 'persona' | 'group';
    id: string;
    revision: number;
  } | null>(null);
  const activeCloneId =
    cloneSearchTarget && cloneSearchTarget.kind !== 'assistant'
      ? `virtual:${cloneSearchTarget.kind}:${cloneSearchTarget.ownerId}`
      : virtualOpen && `virtual:${virtualOpen.kind}:${virtualOpen.id}`;
  const activeDirectoryConversation = ((): ActiveDirectoryConversation | null => {
    if (shell.view === 'agentlab')
      return activeCloneId ? { id: activeCloneId, category: 'clone' } : null;
    if (shell.view !== 'messages') return null;
    if (specialChat === 'assistant')
      return assistantSessionId
        ? { id: `assistant:${assistantSessionId}`, category: 'assistant' }
        : null;
    if (specialChat === 'guild')
      return activeGuildNodeId ? { id: `guild:${activeGuildNodeId}`, category: 'guild' } : null;
    if (arkFeedState) return { id: arkFeedState.conversationId, category: arkFeedState.kind };
    return shell.activeConversationId ? { id: shell.activeConversationId } : null;
  })();
  useGeneratedReplyNotifications(
    noticeAccountKey ? (openedUin ?? '') : '',
    noticeAccountKey ? (noticeConfig.data?.configId ?? '') : '',
    !settingsOpen && (!mobileLayout || !mobileConversationList)
      ? shell.view === 'messages' && specialChat === 'assistant' && assistantSessionId
        ? `assistant:${assistantSessionId}`
        : shell.view === 'agentlab'
          ? (activeCloneId ?? undefined)
          : undefined
      : undefined,
  );
  const accountNotifications = useAccountRecords('notifications', messageScope);
  const conversationViews = useMemo<ConversationViewDirectory>(() => {
    const withMute = (row: Conversation): Conversation =>
      accountNotifications[generatedMuteKey(row.id)] === true
        ? { ...row, preference: { ...fallbackPreference, ...row.preference, muted: true } }
        : row;
    const clone = virtualRows.map(virtualConversationRow).map(withMute);
    const assistant = (directoryAssistant.data ?? []).map(assistantConversationRow).map(withMute);
    const archivedIds = new Set([...hiddenUidSet, ...deletedUidSet]);
    const temporaryRows = Object.values(temporaryConversations).map((entry) => entry.conversation);
    for (const row of temporaryRows) if (row.hidden || row.deleted) archivedIds.add(row.id);
    const regular = sidebarConversations
      .filter((row) => row.type === 'merged' || !archivedIds.has(row.id))
      .map((row) =>
        row.type === 'merged' && (row.mergedKind === 'hidden' || row.mergedKind === 'deleted')
          ? { ...row, title: row.mergedKind === 'hidden' ? '已隐藏会话' : '已删除会话' }
          : row,
      );
    const directory: ConversationViewDirectory = {
      regular: [
        ...regular,
        generatedAggregateRow('clone', clone),
        generatedAggregateRow('assistant', assistant),
      ],
      groupAssistant: conversations.filter(
        (row) => row.type === 'group' && groupAssistantIds.has(row.id) && !archivedIds.has(row.id),
      ),
      official: (officialAccounts.data ?? []).map((item) =>
        feedConversationRow(
          {
            id: item.peerUid,
            name: item.displayName,
            uin: item.targetUin,
            avatarUrl: item.avatarUrl,
            sendTime: item.sendTime,
            prompt: item.prompt,
            unreadCount: item.unreadCount,
            directoryRead: item.directoryRead,
          },
          'official',
        ),
      ),
      service: (serviceAccounts.data ?? []).map((item) =>
        feedConversationRow(
          {
            id: item.appId,
            name: item.displayName,
            avatarUrl: item.avatarUrl,
            sendTime: item.sendTime,
            prompt: item.prompt,
            unreadCount: item.unreadCount,
            directoryRead: item.directoryRead,
          },
          'service',
        ),
      ),
      guild: guildConversationRows,
      hidden: [
        ...temporaryRows.filter((row) => row.hidden),
        ...hiddenConversationsById.values(),
      ].map((row) => ({
        ...row,
        unreadCount:
          archivedUnreadRef.current.get(row.id) ?? unreadByConv[row.id] ?? row.unreadCount ?? 0,
      })),
      deleted: [
        ...temporaryRows.filter((row) => row.deleted),
        ...deletedConversationsById.values(),
      ].map((row) => ({
        ...row,
        unreadCount:
          archivedUnreadRef.current.get(row.id) ?? unreadByConv[row.id] ?? row.unreadCount ?? 0,
      })),
      clone,
      assistant,
    };
    directory.regular = directory.regular.map((row) => {
      if (row.type !== 'merged') return row;
      const members = new Map(
        directory[aggregateView(row.mergedKind)].map((member) => [member.id, member]),
      );
      const unreadMembers = [...members.values()].filter((member) => (member.unreadCount ?? 0) > 0);
      const muted =
        (row.mergedKind === 'clone' || row.mergedKind === 'assistant') &&
        unreadMembers.length > 0 &&
        unreadMembers.every((member) => member.preference?.muted);
      return {
        ...row,
        ...(muted ? { preference: { ...fallbackPreference, ...row.preference, muted: true } } : {}),
        unreadCount: unreadMembers.reduce((count, member) => count + (member.unreadCount ?? 0), 0),
      };
    });
    return directory;
  }, [
    virtualRows,
    accountNotifications,
    unreadByConv,
    directoryAssistant.data,
    sidebarConversations,
    conversations,
    groupAssistantIds,
    groupAssistantPins,
    officialAccounts.data,
    serviceAccounts.data,
    guildConversationRows,
    hiddenConversationsById,
    deletedConversationsById,
    hiddenUidSet,
    deletedUidSet,
    temporaryConversations,
  ]);
  const messageBadgeCount = useMemo(
    () => countMessageBadgeUnread(conversationViews, conversationPrefs, unreadMarkers.aggregates),
    [conversationViews, conversationPrefs, unreadMarkers.aggregates],
  );
  useMessageNotifications({
    selfUin: user.identityValue,
    selfUid: user.uid,
    conversations,
    preferences: conversationPrefs,
    groupAssistantIds,
    resolveGroupSenderName: resolveNoticeGroupSenderName,
    badgeCount: messageBadgeCount,
    foregroundConversation:
      messagesTabActive && !settingsOpen && !dressUpOpen ? selectedUid : undefined,
  });
  conversationViewsRef.current = conversationViews;
  const currentViewRows = useMemo(() => {
    const rows = conversationViewRows(conversationViews, conversationView, allConversationOptions);
    return conversationView === 'groupAssistant'
      ? rows.map((row) => ({
          ...row,
          pinStateKnown: false,
          preference: {
            ...fallbackPreference,
            ...row.preference,
            pinned: isAssistantPinned(row, groupAssistantPins),
          },
        }))
      : rows;
  }, [conversationViews, conversationView, allConversationOptions, groupAssistantPins]);
  const accountPins = useAccountRecords('pins', messageScope);
  const regularViewPreferences = useMemo(
    () => aggregatePinPreferences(conversationViews.regular, conversationPrefs, accountPins),
    [conversationViews.regular, conversationPrefs, accountPins],
  );
  const currentViewPreferences = useMemo(
    () =>
      conversationView === 'groupAssistant'
        ? groupAssistantPreferences(
            conversationViews.groupAssistant,
            conversationPrefs,
            groupAssistantPins,
          )
        : conversationView === 'regular'
          ? regularViewPreferences
          : conversationPrefs,
    [
      conversationView,
      conversationPrefs,
      conversationViews.groupAssistant,
      groupAssistantPins,
      regularViewPreferences,
    ],
  );
  const currentViewPaged =
    conversationView === 'regular' ||
    conversationView === 'all' ||
    conversationView === 'groupAssistant';
  const currentViewQueries =
    conversationView === 'all'
      ? [
          contacts,
          allGroups,
          officialAccounts,
          serviceAccounts,
          guildDirectSessions,
          directoryPersonas,
          directoryGroups,
          directoryAssistant,
          ...(allConversationOptions.includeHidden ? [hiddenSessions] : []),
          ...(allConversationOptions.includeDeleted ? [deletedSessions] : []),
        ]
      : conversationView === 'clone'
        ? [directoryPersonas, directoryGroups]
        : conversationView === 'assistant'
          ? [directoryAssistant]
          : conversationView === 'official'
            ? [officialAccounts]
            : conversationView === 'service'
              ? [serviceAccounts]
              : conversationView === 'guild'
                ? [guildDirectSessions]
                : conversationView === 'hidden'
                  ? [hiddenSessions]
                  : conversationView === 'deleted'
                    ? [deletedSessions]
                    : [contacts, allGroups, hiddenSessions, deletedSessions];
  const currentViewError =
    currentViewQueries
      .map((query) => query.error?.message)
      .filter(Boolean)
      .join('；') || undefined;
  const currentViewLoading =
    !currentViewRows.length && currentViewQueries.some((query) => query.isLoading);
  const currentViewCalendarReady =
    currentViewQueries.every((query) => !query.isLoading) &&
    (!currentViewPaged || !contacts.hasNextPage || Boolean(contacts.error));

  async function createAssistantConversation(): Promise<void> {
    const pushToast = sourceToastPush(notificationSource({ kind: 'assistant' }));
    const source = messageScope;
    try {
      const session = await client.account.createAssistantSession.mutate();
      if (messageScopeRef.current !== source) return;
      void utils.account.listAssistantSessions.invalidate();
      if (conversationView !== 'assistant')
        changeConversationView('assistant', conversationView === 'regular');
      openAssistantConversation(session.id);
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '新建助手会话失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const [deletingAi, setDeletingAi] = useState(false);
  async function deleteAiConversations(rows: Conversation[]): Promise<void> {
    const pushToast = sourceToastPush(
      notificationSource({ kind: 'app', target: { kind: 'conversation-directory', scope: 'all' } }),
    );
    if (deletingAi || !rows.length) return;
    const source = messageScope;
    setDeletingAi(true);
    try {
      const [cloneRuns, assistantSessions] = await Promise.all([
        rows.some((row) => row.generated?.kind !== 'assistant')
          ? client.account.getAgentLabRunningConversations.query()
          : Promise.resolve([]),
        rows.some((row) => row.generated?.kind === 'assistant')
          ? client.account.listAssistantSessions.query()
          : Promise.resolve([]),
      ]);
      if (messageScopeRef.current !== source) return;
      const running = rows.filter((row) =>
        row.generated?.kind === 'assistant'
          ? assistantSessions.some(
              (session) => session.id === row.generated?.sessionId && session.running,
            )
          : cloneRuns.some(
              (run) => run.kind === row.generated?.kind && run.id === row.generated?.ownerId,
            ),
      );
      const deletion = generatedConversationDeletion(rows, running);
      const confirmed = await confirmReadState(deletion.title, deletion.message, {
        tone: 'warning',
        danger: 'solid',
        okLabel: '永久删除',
        cancelLabel: '取消',
      });
      if (!confirmed || messageScopeRef.current !== source) return;
      const failed: string[] = [];
      const assistantRows = rows.filter((row) => row.generated?.kind === 'assistant');
      const sessionIds = assistantRows.flatMap((row) =>
        row.generated?.sessionId ? [row.generated.sessionId] : [],
      );
      await Promise.all([
        ...(sessionIds.length
          ? [
              client.account.deleteAssistantSessions.mutate({ sessionIds }).then(
                () => {
                  if (messageScopeRef.current !== source) return;
                  setDeletedAssistantSessions((current) => [
                    ...new Set([...current, ...sessionIds]),
                  ]);
                  if (assistantSessionId && sessionIds.includes(assistantSessionId))
                    setSpecialChat(null);
                },
                () => {
                  failed.push(...assistantRows.map(conversationRowName));
                },
              ),
            ]
          : []),
        ...rows
          .filter((row) => row.generated?.kind !== 'assistant')
          .map(async (row) => {
            const target = row.generated;
            if (!target || target.kind === 'assistant' || messageScopeRef.current !== source)
              return;
            try {
              if (target.kind === 'persona')
                await client.account.deleteAgentLabPersona.mutate({ personaId: target.ownerId });
              else await client.account.deleteAgentLabGroup.mutate({ groupId: target.ownerId });
              if (messageScopeRef.current !== source) return;
              if (
                (virtualOpen?.kind === target.kind && virtualOpen.id === target.ownerId) ||
                (cloneSearchTarget?.kind === target.kind &&
                  cloneSearchTarget.ownerId === target.ownerId)
              ) {
                setVirtualOpen(null);
                setCloneSearchTarget(null);
                shell.switchView('messages');
                shell.backConversation();
              }
            } catch {
              failed.push(conversationRowName(row));
            }
          }),
      ]);
      if (messageScopeRef.current !== source) return;
      await Promise.all([
        utils.account.listAgentLabPersonas.invalidate(),
        utils.account.listAgentLabGroups.invalidate(),
        utils.account.listAssistantSessions.invalidate(),
        utils.account.generatedConversations.invalidate(),
      ]);
      if (failed.length)
        pushToast({ tone: 'error', title: '部分会话删除失败', detail: failed.join('、') });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '删除会话失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeletingAi(false);
    }
  }
  function exportConversationRows(rows: Conversation[]): void {
    requestConversationExport?.(
      conversationBatchSelection(
        rows.map((row) => ({
          id: row.id,
          name: conversationRowName(row),
          kind:
            row.generated?.kind === 'assistant'
              ? 'assistant'
              : row.generated?.kind === 'group'
                ? 'cloneGroup'
                : row.generated?.kind === 'persona'
                  ? 'persona'
                  : row.directoryKind === 'guild'
                    ? 'guild'
                    : row.directoryKind === 'service'
                      ? 'service'
                      : row.directoryKind === 'official'
                        ? 'official'
                        : row.type === 'group'
                          ? 'group'
                          : 'c2c',
          ownerId:
            row.generated?.ownerId ??
            (row.directoryKind === 'guild'
              ? row.id.slice(6)
              : row.directoryKind === 'service'
                ? row.id.slice(8)
                : row.id),
          sessionId: row.generated?.sessionId,
        })),
      ),
    );
  }
  const [cloneCreateRequest, setCloneCreateRequest] = useState<{
    revision: number;
    friendUids?: string[];
  } | null>(null);
  function handleCreateClone(friendUids?: string[]): void {
    flushAllDirtyDrafts();
    setSettingsOpen(false);
    setMobileConversationList(false);
    setCloneCreateRequest((current) => ({
      revision: (current?.revision ?? 0) + 1,
      friendUids,
    }));
    changeConversationView('clone', conversationView === 'regular');
    setSpecialChat(null);
    shell.switchView('agentlab');
  }
  const [cloneGroupRequest, setCloneGroupRequest] = useState(0);
  const [overviewCalendar, setOverviewCalendar] = useState<{ query: string } | null>(null);
  calendarOpenRef.current = overviewCalendar !== null;
  const overviewCalendarTargets = useMemo(() => {
    if (!overviewCalendar) return [];
    const targets: OverviewCalendarTarget[] = [];
    for (const row of currentViewRows) {
      if (row.type !== 'merged') targets.push(calendarTargetForConversation(row));
    }
    return targets;
  }, [overviewCalendar, currentViewRows]);
  const sidebarView = shell.view === 'agentlab' ? 'messages' : shell.view;
  useLayoutEffect(() => {
    // 离开消息页后只恢复列表现场，不在列表重新挂载时重放上一次定位。
    if (sidebarView !== 'messages') setConversationLocate(null);
  }, [sidebarView]);
  const qzonePageReady = useMobilePageSettled(
    shell.view === 'qzone' && !arkFeedState,
    user.identityValue,
  );
  const [contactDirectoryQuery, setContactDirectoryQuery] = useState('');

  /** 防撤回面板「记录」页点一行：打开该会话的撤回列表（复用聊天区气泡与筛选）。 */
  function handleOpenRecallsAt(kind: 'c2c' | 'group', conv: string): void {
    const pushToast = sourceToastPush(
      notificationSource({ kind: 'conversation', conversationKind: kind, conv }),
    );
    // 同 id 理论上不会横跨群/私聊，但类型对得上才更稳（群号纯数字、uid 是 u_ 前缀）。
    const wantGroup = kind === 'group';
    const target = [
      conversations.find((c) => c.id === conv),
      hiddenConversationsById.get(conv),
      deletedConversationsById.get(conv),
    ].find((c) => c && c.type === (wantGroup ? 'group' : 'direct'));
    if (!target) {
      pushToast({
        tone: 'info',
        durationKind: 'failure',
        title: '找不到该会话',
        detail: '它可能已不在会话列表里，无法打开撤回列表。',
      });
      return;
    }
    void recalls.open(target, 'settings');
  }

  const openProfileChat = async (target: ProfileChatTarget): Promise<void> => {
    const pushToast = sourceToastPush(
      memberCard
        ? restoreNotificationSource(memberCard, setMemberCard)
        : notificationSource({ kind: 'app', target: { kind: 'view', view: 'contacts' } }),
    );
    const accountUin = user.identityValue;
    let candidate: Conversation;
    if (target.kind === 'group') candidate = target.conversation;
    else {
      let peer = target.user;
      if (!peer.id && peer.identityLabel === 'QQ') {
        const profile = await client.account.getProfileByUin.query({ uin: peer.identityValue });
        if (profile?.uid) peer = { ...peer, id: profile.uid };
      }
      if (!peer.id) {
        pushToast({ tone: 'info', durationKind: 'failure', title: '暂时无法确定此人的会话身份' });
        return;
      }
      const local =
        profileByUid.get(peer.id) ?? (await client.account.getProfile.query({ uid: peer.id }));
      peer = localProfileUser(peer, local ?? undefined);
      candidate = {
        id: peer.id,
        type: 'direct',
        otherUser: peer,
        group: null,
        members: [],
        updatedAt: new Date(0).toISOString(),
        preference: fallbackPreference,
        unreadCount: 0,
        lastMessage: null,
      };
    }
    if (useViewState.getState().openedUin !== accountUin) return;
    const id = candidate.id;
    const known =
      conversations.find((conversation) => conversation.id === id) ??
      hiddenConversationsById.get(id) ??
      deletedConversationsById.get(id) ??
      candidate;
    const needsAppearance =
      !recentContactsData.some((contact) => contact.targetUid === id) || hiddenUidSet.has(id);
    if (needsAppearance)
      setTemporaryConversations((current) =>
        current[id]
          ? current
          : {
              ...current,
              [id]: { conversation: known, appearedAt: Date.now() },
            },
      );
    setArkFeedState(null);
    shell.openConversation(id);
    setConversationLocate({ id, revision: Date.now() });
  };

  type PreviewSource = 'member' | 'latest' | 'contact' | 'group-profile' | 'speech' | 'menu';
  const [specialPreview, setSpecialPreview] = useState<ConcreteConversation | null>(null);
  const [privatePreview, setPrivatePreview] = useState<{
    account: string;
    source: PreviewSource;
    contactScope: string | null;
    conversation: Conversation;
    sender?: string;
    cursor?: ProfilePreviewCursor;
    rows: MessageWire[];
    loading: boolean;
    loadingMore: boolean;
    error: string | null;
    hasMore: boolean;
  } | null>(null);
  const previewRequest = useRef(0);
  const closePrivatePreview = () => {
    previewRequest.current++;
    setPrivatePreview(null);
  };
  function previewMenuConversation(conversation: ConcreteConversation) {
    if (conversation.generated || readonlyConversationKind(conversation)) {
      closePrivatePreview();
      setSpecialPreview(conversation);
    } else {
      setSpecialPreview(null);
      void previewConversation(conversation, 'menu');
    }
  }
  const contactPreviewScope = JSON.stringify([
    shell.view,
    shell.contactTab,
    shell.selectedContactId,
    shell.selectedGroupConversationId,
    shell.contactWorkspaceTab,
    shell.contactOverviewOpen,
    shell.contactNotice,
  ]);
  useEffect(() => {
    previewRequest.current++;
    setPrivatePreview(null);
  }, [memberCard?.member.id, memberCard?.member.identityValue, user.identityValue]);
  useEffect(() => {
    if (
      (privatePreview?.source !== 'contact' && privatePreview?.source !== 'group-profile') ||
      privatePreview.contactScope === contactPreviewScope
    )
      return;
    previewRequest.current++;
    setPrivatePreview(null);
  }, [contactPreviewScope, privatePreview?.source, privatePreview?.contactScope]);
  useEffect(() => {
    if (privatePreview?.source === 'latest' && privatePreview.conversation.id !== selectedUid) {
      previewRequest.current++;
      setPrivatePreview(null);
    }
  }, [privatePreview?.source, privatePreview?.conversation.id, selectedUid]);
  async function previewPrivateChat(peer: User, source: 'member' | 'contact' = 'member') {
    await previewConversation(
      {
        id: peer.uid || (peer.id.startsWith('u_') ? peer.id : ''),
        type: 'direct',
        otherUser: peer,
        group: null,
        members: [],
        updatedAt: new Date(0).toISOString(),
        preference: fallbackPreference,
        unreadCount: 0,
        lastMessage: null,
      },
      source,
    );
  }
  async function previewConversation(
    conversation: Conversation,
    source: PreviewSource,
    sender?: string,
  ) {
    const account = user.identityValue;
    const binding = messageBindingRef.current ?? undefined;
    const scope = messageScope;
    const contactScope =
      source === 'contact' || source === 'group-profile' ? contactPreviewScope : null;
    const request = ++previewRequest.current;
    const isCurrent = () =>
      request === previewRequest.current &&
      messageScopeRef.current === scope &&
      useViewState.getState().openedUin === account;
    setPrivatePreview({
      account,
      source,
      contactScope,
      conversation,
      sender,
      rows: [],
      loading: true,
      loadingMore: false,
      error: null,
      hasMore: false,
    });
    try {
      if (
        conversation.type === 'direct' &&
        !conversation.id &&
        /^\d+$/.test(conversation.otherUser.identityValue)
      ) {
        const profile = await client.account.getProfileByUin.query({
          uin: conversation.otherUser.identityValue,
          ...binding,
        });
        if (profile?.uid)
          conversation = {
            ...conversation,
            id: profile.uid,
            otherUser: { ...conversation.otherUser, id: profile.uid },
          };
      }
      if (!conversation.id) throw new Error('缺少会话身份');
      if (conversation.type === 'direct' && source !== 'menu') {
        const peer = conversation.otherUser;
        const local =
          profileByUid.get(peer.uid || peer.id) ??
          (await client.account.getProfile.query({ uid: peer.uid || peer.id, ...binding }));
        conversation = { ...conversation, otherUser: localProfileUser(peer, local ?? undefined) };
      }
      if (!isCurrent()) return;
      const page = await readProfilePreviewPage({
        binding,
        kind: conversation.type === 'group' ? 'group' : 'c2c',
        conv: conversation.id,
        sender,
      });
      if (!isCurrent()) return;
      setPrivatePreview({
        account,
        source,
        contactScope,
        conversation,
        sender,
        cursor: page.cursor,
        rows: page.rows.map(toMessageWire),
        loading: false,
        loadingMore: false,
        error: null,
        hasMore: page.hasMore,
      });
    } catch (error) {
      if (isCurrent())
        setPrivatePreview((current) =>
          current
            ? {
                ...current,
                loading: false,
                error: error instanceof Error ? error.message : String(error),
              }
            : null,
        );
    }
  }

  async function loadPrivatePreview() {
    const snapshot = privatePreview;
    if (!snapshot || snapshot.loadingMore || !snapshot.hasMore) return;
    const request = previewRequest.current;
    const first = snapshot.rows[0];
    if (!first && !snapshot.sender) return;
    setPrivatePreview({ ...snapshot, loadingMore: true, error: null });
    try {
      const page = await readProfilePreviewPage({
        binding: messageBindingRef.current ?? undefined,
        kind: snapshot.conversation.type === 'group' ? 'group' : 'c2c',
        conv: snapshot.conversation.id,
        beforeSeq: first?.msgSeq,
        sender: snapshot.sender,
        cursor: snapshot.cursor,
      });
      if (
        request !== previewRequest.current ||
        messageScopeRef.current !== messageScope ||
        useViewState.getState().openedUin !== snapshot.account
      )
        return;
      setPrivatePreview({
        ...snapshot,
        rows: [...page.rows.map(toMessageWire), ...snapshot.rows],
        cursor: page.cursor,
        loadingMore: false,
        hasMore: page.hasMore,
      });
    } catch (error) {
      if (request === previewRequest.current && messageScopeRef.current === messageScope)
        setPrivatePreview({
          ...snapshot,
          loadingMore: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  }

  useEffect(() => {
    resolveProfiles(loaded.map((message) => message.senderUid));
  }, [loaded, resolveProfiles]);

  useEffect(() => {
    if (!privatePreview) return;
    resolveProfiles([
      ...privatePreview.rows.map((row) => row.senderUid),
      ...(privatePreview.conversation.type === 'direct'
        ? [privatePreview.conversation.otherUser.id]
        : []),
    ]);
    if (privatePreview?.conversation.type !== 'group') return;
    const group = privatePreview.conversation;
    const account = privatePreview.account;
    const known = new Set(
      [...group.members, ...(selectedUid === group.id ? currentGroupMembers : [])].map(
        (member) => member.id,
      ),
    );
    const uids = privatePreview.rows.flatMap((row) => [
      row.senderUid,
      ...extractGrayTipUids(row.elements),
    ]);
    resolveProfiles(uids);
    resolvePreviewMembers(
      group.id,
      uids,
      known,
      () => useViewState.getState().openedUin === account,
    );
  }, [privatePreview, currentGroupMembers, selectedUid, resolvePreviewMembers, resolveProfiles]);

  const resolvedPreviewConversation = useMemo(() => {
    const conversation = privatePreview?.conversation;
    if (conversation?.type === 'direct')
      return {
        ...conversation,
        otherUser: localProfileUser(
          conversation.otherUser,
          profileByUid.get(conversation.otherUser.uid || conversation.otherUser.id),
        ),
      };
    if (conversation?.type !== 'group') return conversation;
    const members = new Map(
      [
        ...conversation.members,
        ...(selectedUid === conversation.id ? currentGroupMembers : []),
        ...Object.values(previewMembers[conversation.id] ?? {}).map(mapGroupMemberWire),
      ].map((member) => [member.id, member]),
    );
    return { ...conversation, members: [...members.values()] };
  }, [
    privatePreview?.conversation,
    selectedUid,
    currentGroupMembers,
    previewMembers,
    mapGroupMemberWire,
    profileByUid,
  ]);

  const previewMemberMap = useMemo(
    () => new Map(resolvedPreviewConversation?.members.map((member) => [member.id, member]) ?? []),
    [resolvedPreviewConversation?.members],
  );
  const previewRows = privatePreview?.rows;
  const previewAccount = privatePreview?.account;
  const previewTemplateMessages = useMemo(() => {
    if (!previewRows || !resolvedPreviewConversation || previewAccount !== user.identityValue)
      return [];
    const replyIndex = createReplyPreviewIndex(previewRows);
    const lookupByUin = createMemberUinLookup(previewMemberMap);
    return previewRows.map((row) =>
      messageToTemplate(
        row,
        resolvedPreviewConversation,
        user,
        previewMemberMap,
        botUids,
        replyIndex,
        profileByUid,
        lookupByUin,
      ),
    );
  }, [
    previewRows,
    previewAccount,
    resolvedPreviewConversation,
    user,
    previewMemberMap,
    botUids,
    profileByUid,
  ]);
  const floatingPreview =
    privatePreview?.source === 'latest' ||
    privatePreview?.source === 'speech' ||
    privatePreview?.source === 'menu';
  const conversationPreviewContent =
    privatePreview &&
    resolvedPreviewConversation &&
    privatePreview.account === user.identityValue ? (
      <GapMessagesModal
        preview
        embedded={!floatingPreview}
        title={
          privatePreview.sender
            ? '本群发言'
            : privatePreview.source === 'latest'
              ? '预览新消息'
              : privatePreview.source === 'menu'
                ? '预览会话'
                : undefined
        }
        conversation={resolvedPreviewConversation}
        user={user}
        messages={previewTemplateMessages}
        renderers={messageRenderers}
        loading={privatePreview.loading}
        loadingMore={privatePreview.loadingMore}
        error={privatePreview.rows.length ? null : privatePreview.error}
        hasMore={privatePreview.hasMore}
        moreFailed={Boolean(privatePreview.error)}
        totalCount={privatePreview.rows.length}
        onLoadMore={() => void loadPrivatePreview()}
        onRetry={() =>
          void previewConversation(
            privatePreview.conversation,
            privatePreview.source,
            privatePreview.sender,
          )
        }
        onClose={closePrivatePreview}
        onLocateMessage={(target) => {
          const conversation = resolvedPreviewConversation;
          if (
            !conversations.some((item) => item.id === conversation.id) &&
            !hiddenConversationsById.has(conversation.id) &&
            !deletedConversationsById.has(conversation.id)
          )
            setTemporaryConversations((current) => ({
              ...current,
              [conversation.id]: { conversation, appearedAt: Date.now() },
            }));
          closePrivatePreview();
          setMemberCard(null);
          setNumberGroupCard(null);
          jumpToConvSeq(
            conversation.type === 'group' ? 'group' : 'c2c',
            conversation.id,
            target.seq == null ? undefined : String(target.seq),
            true,
            undefined,
            target.msgId,
          );
        }}
      />
    ) : null;

  const recalledView = recalledConv ? (
    <RecalledMessagesModal
      key={JSON.stringify([messageScope, recalledConv.type, recalledConv.id])}
      embedded={recalls.origin === 'settings'}
      conversation={recalledConv}
      user={user}
      messages={recalledTemplateMessages}
      renderers={messageRenderers}
      loading={recalledLoading}
      hasMore={recalls.hasMore}
      onLoadMore={recalls.loadMore}
      error={recalls.error}
      onRetry={() => void recalls.retry()}
      onClose={() => recalls.close()}
      onJumpToMessage={(seq, messageId) => {
        const target = convFetchKey(recalledConv);
        if (recalls.origin === 'settings' || mobileLayout) recalls.close();
        if (recalls.origin === 'settings') setSettingsOpen(false);
        jumpToConvSeq(target.kind, target.conv, seq, true, undefined, messageId);
      }}
    />
  ) : null;
  const conversationRecords = !messagesTabActive ? null : deletedConv?.id === selectedUid ? (
    <DeletedMessagesModal
      key={deletedConv.id}
      conversation={deletedConv}
      user={user}
      messages={deletedTemplateMessages}
      hiddenIds={hiddenDeletedIds}
      loading={deletedLoading}
      hasMore={deletions.hasMore}
      onLoadMore={deletions.loadMore}
      error={deletions.error}
      onRetry={() => void deletions.retry()}
      onRestore={(msgId) => handleRestoreMessage(msgId, deletedConv)}
      onLocate={(seq, messageId) => {
        const target = convFetchKey(deletedConv);
        if (mobileLayout) closeConversationRecords();
        jumpToConvSeq(target.kind, target.conv, seq, true, undefined, messageId);
      }}
      onClose={closeConversationRecords}
    />
  ) : recalls.origin === 'conversation' && recalledConv?.id === selectedUid ? (
    recalledView
  ) : null;

  const openAnnouncements = useOpenAnnouncement();
  const openAppSearchEntryNow = (entry: AppSearchEntry) => {
    setSearchDismissed(true);
    setSearchFocused(false);
    setSettingsOpen(false);
    setSettingsSearchTarget(null);
    setMaintenanceTool(null);
    setDressUpOpen(false);
    const target = entry.target;
    if (target.kind === 'setting') {
      setSettingsSection(target.section);
      if (target.item || target.settingId)
        setSettingsSearchTarget({
          section: target.section,
          item: target.item,
          settingId: target.settingId,
          revision: Date.now(),
        });
      setSettingsOpen(true);
    } else if (target.kind === 'conversation-directory') {
      flushAllDirtyDrafts();
      setSurfaceNavigation((value) => value + 1);
      shell.setQuery('');
      changeConversationView(
        target.scope === 'virtual'
          ? 'clone'
          : target.scope === 'guild'
            ? 'guild'
            : target.scope === 'all'
              ? 'all'
              : 'regular',
      );
      shell.switchView('messages');
    } else if (target.kind === 'tool') {
      if (target.tool === 'assistant') {
        changeConversationView('assistant');
        if (directoryAssistant.data?.[0]) openAssistantConversation(directoryAssistant.data[0].id);
        else void createAssistantConversation();
        return;
      }
      setToolSearchRequest((previous) => ({
        scope: messageScope,
        tool: target.tool,
        exportMode: target.exportMode,
        revision: (previous?.revision ?? 0) + 1,
      }));
    } else if (target.kind === 'clone-create') {
      if (target.group) {
        flushAllDirtyDrafts();
        setCloneGroupRequest((current) => current + 1);
        changeConversationView('clone', conversationView === 'regular');
        setSpecialChat(null);
        shell.switchView('agentlab');
      } else handleCreateClone();
    } else if (target.kind === 'self-profile') {
      if (shell.view === 'messages') flushAllDirtyDrafts();
      setMemberCard(null);
      setPrivatePreview(null);
      shell.openContactDetails({ ...user, createdAt: '' }, target.tab);
    } else if (target.kind === 'composition') compositionWindow.open();
    else if (target.kind === 'announcements') openAnnouncements();
    else if (target.kind === 'dressup') {
      setDressUpEmojiTarget(null);
      setDressUpSearchKind(target.dressKind ?? 'usage');
      setDressUpOpen(true);
    } else {
      if (shell.view === 'messages' && target.view !== 'messages') flushAllDirtyDrafts();
      if (target.view === 'guild-direct') {
        changeConversationView('guild');
        shell.switchView('messages');
        return;
      }
      shell.switchView(target.view);
    }
  };

  const openAppSearchEntry = (entry: AppSearchEntry) => {
    if (entry.target.kind === 'setting') openAppSearchEntryNow(entry);
    else settingsNavigation.navigate(() => openAppSearchEntryNow(entry));
  };

  const openNotificationTarget = useStableCallback(
    (target: import('../lib/notificationNavigation').NotificationTarget) => {
      settingsNavigation.navigate(() => {
        setSettingsOpen(false);
        if (target.kind === 'app') {
          openAppSearchEntryNow({
            id: 'notification',
            title: '',
            path: '',
            keywords: [],
            target: target.target,
          });
          if (target.target.kind === 'setting' && target.recordId)
            setSettingsSearchTarget({
              ...target.target,
              recordId: target.recordId,
              revision: Date.now(),
            });
        } else if (target.kind === 'task') {
          setToolSearchRequest((previous) => ({
            scope: messageScope,
            tool: 'tasks',
            revision: (previous?.revision ?? 0) + 1,
          }));
          useWorkspaceMenu.getState().focusTask(target.id);
        } else if (target.kind === 'conversation') {
          jumpToConvSeq(
            target.conversationKind === 'group' ? 'group' : 'c2c',
            target.conv,
            target.seq,
            false,
            undefined,
            target.msgId,
          );
        } else if (target.kind === 'mail') {
          setMailSearchTarget({
            kind: 'mailMessage',
            id: target.mailId,
            folderId: target.folderId,
            revision: String(Date.now()),
          });
          openMailView();
        } else if (target.kind === 'contact') {
          const contact = profileContacts.find(
            (person) => person.id === target.id || person.uid === target.id,
          );
          if (contact) shell.openContactDetails(contact, target.tab);
          else shell.switchView('contacts');
        } else if (target.kind === 'contact-notice') {
          shell.openContactNotice(target.notice);
        } else if (target.kind === 'assistant') {
          changeConversationView('assistant');
          shell.switchView('messages');
        } else if (target.kind === 'generated-reply') {
          const { conversationKind: kind, conversationId: id, messageId } = target;
          const rowId = kind === 'assistant' ? `assistant:${id}` : `virtual:${kind}:${id}`;
          const view = kind === 'assistant' ? 'assistant' : 'clone';
          const row = conversationViewsRef.current?.[view].find((item) => item.id === rowId);
          const title = row
            ? conversationRowName(row)
            : kind === 'assistant'
              ? 'WeQ 助手'
              : '克隆会话';
          const hit: GeneratedSearchHit | undefined = messageId
            ? {
                category: kind === 'assistant' ? 'assistantMessage' : 'cloneMessage',
                kind,
                ownerId: kind === 'assistant' ? 'assistant' : id,
                sessionId: kind === 'assistant' ? id : null,
                messageId,
                title,
                sessionTitle: title,
                content: '',
                ts: 0,
              }
            : undefined;
          if (kind === 'assistant') {
            changeConversationView('assistant');
            openAssistantConversation(id, hit);
          } else {
            flushAllDirtyDrafts();
            locateConversationInView(rowId, 'clone');
            setMobileConversationList(false);
            setSpecialChat(null);
            setArkFeedState(null);
            setCloneSearchTarget(hit ?? null);
            setVirtualOpen({ kind, id, revision: Date.now() });
            shell.switchView('agentlab');
          }
        } else if (target.kind === 'group') {
          const group = contactDirectoryConversations.find(
            (conversation) => conversation.type === 'group' && conversation.id === target.id,
          );
          setGroupWorkspaceLocation({ code: target.id, section: target.section ?? 'profile' });
          shell.openGroupDetails(
            group?.type === 'group'
              ? group
              : sharedGroupConversation({
                  code: target.id,
                  name: target.id,
                  avatar: avatarFromGroupCode(target.id) ?? '',
                }),
          );
        } else if (target.kind === 'qzone') {
          flushAllDirtyDrafts();
          setArkFeedState(null);
          setQzoneSpaceRequest({
            accountUin: user.identityValue,
            uin: target.target.uin,
            target: target.target,
            revision: crypto.randomUUID(),
          });
          shell.switchView('qzone');
        } else if (target.kind === 'group-resource') {
          openGroupResourceWindow(target.request);
        }
      });
    },
  );
  useEffect(() => onNotificationNavigation(openNotificationTarget), [openNotificationTarget]);

  useMobileBack(
    mobileLayout &&
      !mobileConversationList &&
      ((shell.view === 'messages' && Boolean(specialChat || arkFeedState)) ||
        shell.view === 'agentlab'),
    () => setMobileConversationList(true),
    10,
    () => document.querySelector<HTMLElement>('.app-shell > .chat-main'),
  );

  const locateCalendarMessage: CalendarNavigate = (target, anchor, record) => {
    flushAllDirtyDrafts();
    setMobileConversationList(false);
    if (target.kind === 'guild') {
      locateConversationInView(`guild:${target.conv}`, 'guild');
      setSpecialChat('guild');
      setArkFeedState(null);
      setGuildSearchTarget({
        kind: 'guildMessage',
        nodeId: target.conv,
        msgId: anchor.id,
        msgSeq: anchor.seq,
        revision: crypto.randomUUID(),
      });
      shell.switchView('messages');
    } else if (target.kind === 'assistant') {
      changeConversationView('assistant');
      openAssistantConversation(target.conv, {
        category: 'assistantMessage',
        kind: 'assistant',
        ownerId: 'assistant',
        sessionId: target.conv,
        messageId: anchor.id,
        title: target.name,
        sessionTitle: target.name,
        content: '',
        ts: anchor.time * 1000,
      });
    } else if (target.kind === 'persona' || target.kind === 'cloneGroup') {
      changeConversationView('clone');
      setSpecialChat(null);
      setCloneSearchTarget({
        category: 'cloneMessage',
        kind: target.kind === 'persona' ? 'persona' : 'group',
        ownerId: target.conv,
        sessionId: anchor.sessionId ?? null,
        messageId: anchor.id,
        title: target.name,
        sessionTitle: '',
        content: '',
        ts: anchor.time * 1000,
      });
      shell.switchView('agentlab');
    } else if (target.kind === 'official' || target.kind === 'service') {
      changeConversationView(target.kind);
      setSpecialChat(null);
      setArkFeedState({
        kind: target.kind,
        conversationId: target.kind === 'service' ? `service:${target.conv}` : target.conv,
        title: target.name,
        anchorId: anchor.id,
      });
      shell.switchView('messages');
    } else {
      jumpToConvSeq(
        target.kind === 'group' ? 'group' : 'c2c',
        target.conv,
        anchor.seq,
        false,
        record,
        anchor.id,
      );
    }
  };

  const selectSidebarContact = useStableCallback((contact: Contact) =>
    settingsNavigation.navigate(() => {
      setSurfaceNavigation((value) => value + 1);
      shell.selectContact(contact);
    }),
  );
  const selectSidebarGroup = useStableCallback((id: string) =>
    settingsNavigation.navigate(() => {
      setSurfaceNavigation((value) => value + 1);
      setGroupWorkspaceLocation({ code: id, section: 'profile' });
      shell.selectGroup(id);
    }),
  );
  const locateUnreadConversation = useStableCallback(() =>
    settingsNavigation.navigate(() => {
      const target = unreadConversationCycle.next(
        conversationViews.regular,
        regularViewPreferences,
        unreadMarkers.aggregates,
      );
      if (!target) return;
      setSurfaceNavigation((value) => value + 1);
      setSettingsOpen(false);
      setMaintenanceTool(null);
      setDressUpOpen(false);
      shell.switchView('messages');
      setArkFeedState(null);
      changeConversationView('regular');
      shell.setQuery('');
      if (isMobileShell()) {
        setMobileConversationList(true);
        shell.backConversation();
      }
      setConversationLocate((previous) => ({
        id: target.id,
        revision: Math.max(Date.now(), (previous?.revision ?? 0) + 1),
        align: 'start',
      }));
    }),
  );
  const replyJump = useStableCallback(jumpToSeq);
  const chatContent = (
    <ReplyJumpContext.Provider value={replyJump}>
      <ForwardKindContext.Provider value={isGroup ? 'group' : 'c2c'}>
        <ConvContext.Provider value={isGroup ? (selectedConversation?.id ?? '') : ''}>
          <ChatShell
            user={user}
            selfProfileGroup={
              messagesTabActive && selectedConversation?.type === 'group'
                ? { code: selectedConversation.id, name: selectedConversation.group.name }
                : undefined
            }
            view={sidebarView}
            activeRailItem={
              settingsOpen || maintenanceTool ? 'settings' : dressUpOpen ? 'dressup' : undefined
            }
            query={shell.query}
            contactTab={shell.contactTab}
            activeNotice={shell.contactNotice}
            sidebarWidth={fullBleedView ? 0 : shell.sidebarWidth}
            mainOpen={
              (!mobileLayout || !mobileConversationList) &&
              (shell.mainOpen ||
                shell.view === 'mail' ||
                (shell.view === 'messages' && Boolean(arkFeedState)) ||
                (shell.view === 'messages' && Boolean(specialChat)) ||
                (shell.view === 'agentlab' && Boolean(virtualOpen || cloneSearchTarget)))
            }
            messageBadgeCount={
              preferenceValue(
                'showMessageUnreadBadge',
                displaySettings.data?.showMessageUnreadBadge,
              )
                ? messageBadgeCount
                : 0
            }
            contactBadgeCount={unreadMarkers.requests ? friendNoticeCount + groupNoticeCount : 0}
            onMessageBadgeClick={locateUnreadConversation}
            mailBadgeCount={mailPreferences.data?.showUnread === false ? 0 : mailUnread}
            showTools={false}
            railFooterContent={() => <WorkspaceMenuButton />}
            friendNoticeCount={unreadMarkers.requests ? friendNoticeCount : 0}
            groupNoticeCount={unreadMarkers.requests ? groupNoticeCount : 0}
            onViewChange={(view) =>
              settingsNavigation.navigate(() => {
                if (view === 'guild-direct' || view === 'agentlab') {
                  setMobileConversationList(true);
                  changeConversationView(view === 'guild-direct' ? 'guild' : 'clone');
                  shell.switchView('messages');
                  return;
                }
                setSurfaceNavigation((value) => value + 1);
                // 离开消息页 —— 另一个草稿落库时机。
                if (shell.view === 'messages' && view !== 'messages') {
                  flushAllDirtyDrafts();
                }
                shell.switchView(view);
              })
            }
            onGoHome={() =>
              settingsNavigation.navigate(() => {
                setSurfaceNavigation((value) => value + 1);
                if (shell.view === 'messages') {
                  flushAllDirtyDrafts();
                }
                shell.switchView('home');
              })
            }
            onOpenSettings={() => {
              setDressUpOpen(false);
              setMaintenanceTool(null);
              setSettingsSection(undefined);
              setSettingsOpen(true);
            }}
            onOpenCollection={() =>
              settingsNavigation.navigate(() => shell.switchView('collections'))
            }
            onOpenWonderfulTools={() => {
              setSettingsSection('diagnostics');
              setSettingsOpen(true);
            }}
            onOpenAntiRecall={() => {
              setSettingsSection('anti-recall');
              setSettingsOpen(true);
            }}
            onOpenDbRepair={() => openMaintenance('db-repair')}
            onOpenQzoneAlbum={() => setQzoneAlbumOpen(true)}
            onOpenDressUp={() =>
              settingsNavigation.navigate(() => {
                setSettingsOpen(false);
                setDressUpEmojiTarget(null);
                setDressUpSearchKind('usage');
                setDressUpOpen(true);
              })
            }
            onOpenProfile={noopAsync}
            onOpenAbout={noopAsync}
            onOpenInvite={noopAsync}
            onQueryChange={(query) => {
              searchReturn.clear();
              shell.setQuery(query);
            }}
            onSearchFocus={() => {
              setSearchFocused(true);
              setSearchDismissed(false);
            }}
            // 搜索框下方的浮层：范围先于输入显示，结果由关键词控制。
            // 它挂在搜索框上（不是可滚动列表里），所以会话列表怎么滚都看得见。
            searchPanel={
              (searchQuery || searchFocused) && !searchDismissed ? (
                <SearchResultsPanel
                  key={searchAccountKey}
                  navigation={searchReturn}
                  renderers={messageRenderers}
                  user={user}
                  groupMembers={memberMapForGroup}
                  resolveGroupMembers={resolveRecordsMembers}
                  onJumpMessage={({ source, targetUid, msgSeq, msgId }) =>
                    jumpToConvSeq(
                      source === 'group' ? 'group' : 'c2c',
                      targetUid,
                      msgSeq,
                      false,
                      undefined,
                      msgId,
                    )
                  }
                  renderDetail={(hit, onBack) => {
                    if (!isContentSearchHit(hit)) return null;
                    const target = hit.target;
                    const binding = sharedAccountBinding();
                    if (!binding)
                      return <div className="weq-search-empty">账号已关闭，请重新打开搜索</div>;
                    switch (target.kind) {
                      case 'groupBulletin':
                      case 'groupEssence':
                        return (
                          <SearchGroupContentResult
                            target={{ ...target, ...binding }}
                            onClose={onBack}
                            onJump={(group, seq) =>
                              jumpToConvSeq('group', group, String(seq), true)
                            }
                          />
                        );
                      case 'flashFile':
                        return (
                          <SearchFlashTransferViewer
                            embedded
                            filesetId={target.filesetId}
                            title="闪传搜索结果"
                            initialTarget={target}
                            onClose={onBack}
                          />
                        );
                      case 'qzonePublicComment':
                        return (
                          <QzonePublicSearchResult
                            selfUin={user.identityValue}
                            target={target}
                            onClose={onBack}
                          />
                        );
                      case 'groupAlbum':
                        return (
                          <GroupAlbumDialog
                            embedded
                            groupCode={target.groupCode}
                            groupName={hit.sourceName}
                            initialAlbumId={target.albumId}
                            onClose={onBack}
                          />
                        );
                      case 'groupFile':
                        return (
                          <GroupFileDialog
                            embedded
                            groupCode={target.groupCode}
                            groupName={hit.sourceName}
                            initialFolderId={target.folderId}
                            initialFileId={target.fileId}
                            onJumpToMessage={(seq, msgId) =>
                              jumpToConvSeq('group', target.groupCode, seq, false, undefined, msgId)
                            }
                            onClose={onBack}
                          />
                        );
                      default:
                        return null;
                    }
                  }}
                  keyword={searchQuery}
                  numberLookupKeyword={shell.query}
                  onOpenNumberProfile={(profile, anchor) => {
                    if (profile.kind === 'group') {
                      setMemberCard(null);
                      setNumberGroupCard({
                        accountUin: openedUin,
                        conversation: sharedGroupConversation({
                          code: profile.id,
                          name: profile.name || profile.id,
                          avatar: avatarFromGroupCode(profile.id) ?? '',
                        }),
                        anchor,
                      });
                    } else {
                      setNumberGroupCard(null);
                      const rect = anchor.getBoundingClientRect();
                      setMemberCard({
                        member: {
                          id: '',
                          username: profile.id,
                          identityLabel: 'QQ',
                          identityValue: profile.id,
                          displayName: profile.name || profile.id,
                          avatarUrl: avatarFromUin(profile.id),
                        },
                        anchor: { x: rect.right, y: rect.bottom },
                        groupContext: null,
                      });
                    }
                  }}
                  quick={globalSearch.quick}
                  quickLoading={globalSearch.quickLoading}
                  slow={globalSearch.slow}
                  slowLoading={globalSearch.slowLoading}
                  quickError={globalSearch.quickError}
                  slowError={globalSearch.slowError}
                  categoryStates={globalSearch.categoryStates}
                  categories={searchCategories}
                  onCategoriesChange={setSearchCategories}
                  sources={searchSources}
                  onSourcesChange={setSearchSources}
                  onRetry={globalSearch.retry}
                  onSelect={openSearchHit}
                  appSearchEnabled={appSearchEnabled}
                  numberLookupEnabled={numberLookupEnabled}
                  onNumberLookupEnabledChange={setNumberLookupEnabled}
                  onAppSearchEnabledChange={(enabled) => {
                    searchReturn.clear();
                    setAppSearchEnabled(enabled);
                  }}
                  onSelectAppEntry={openAppSearchEntry}
                />
              ) : null
            }
            onOpenFriendNotices={() =>
              settingsNavigation.navigate(() => shell.openContactNotice('friend'))
            }
            onOpenGroupNotices={() =>
              settingsNavigation.navigate(() => shell.openContactNotice('group'))
            }
            onOpenContactOverview={() => settingsNavigation.navigate(shell.openContactOverview)}
            contactOverviewActive={
              shell.contactOverviewOpen &&
              !shell.selectedContact &&
              !shell.selectedGroupConversation &&
              !shell.contactNotice
            }
            onContactTabChange={shell.changeContactTab}
            onRefreshContacts={() => {
              void refreshContacts();
            }}
            refreshingContacts={refreshingContacts}
            onSidebarWidthChange={shell.updateSidebarWidth}
            sidebarContent={
              <MobileSidebarPages
                key={user.identityValue}
                activeKey={sidebarView}
                renderPage={(view) =>
                  view === 'messages' || view === 'contacts' || !fullBleedView ? (
                    <>
                      <ChatSidebarContent
                        active={view === sidebarView}
                        user={user}
                        view={view}
                        contactTab={shell.contactTab}
                        conversations={
                          view === 'contacts'
                            ? contactDirectoryConversations
                            : view === 'messages'
                              ? currentViewRows
                              : conversations
                        }
                        activeConversationId={
                          activeDirectoryConversation?.id ?? shell.activeConversationId
                        }
                        selectedGroupConversationId={shell.selectedGroupConversationId}
                        selectedContactId={shell.selectedContactId}
                        conversationPrefs={currentViewPreferences}
                        drafts={drafts}
                        contacts={buddyContacts}
                        categoryDefinitions={(categories.data ?? []) as CategoryWire[]}
                        specialContactSections={specialContactSections}
                        historicalContactSections={historicalContactSections}
                        loading={view === 'messages' ? currentViewLoading : sidebarLoading}
                        onLoadMoreConversations={
                          view === sidebarView && currentViewPaged ? loadMoreContacts : undefined
                        }
                        conversationsHasMore={currentViewPaged && contactsHasMore}
                        conversationsLoadingMore={contactsLoadingMore}
                        query={shell.query}
                        onSelectConversation={handleSelectConversation}
                        onSelectContact={selectSidebarContact}
                        onSelectGroup={selectSidebarGroup}
                        activateToolsOnSelect={false}
                      />
                      {view === sidebarView && (
                        <OverlayScrollbar
                          targetSelector='.app-shell .sidebar-body [data-mobile-sidebar-active="true"] [data-retained-panel]:not([hidden])'
                          className="weq-sidebar-scrollbar"
                          refreshKey={`sidebar:${shell.view}:${shell.query}`}
                        />
                      )}
                    </>
                  ) : null
                }
              />
            }
            mainContent={
              <WorkspaceContent>
                <MailWorkspace
                  key={`mail:${user.identityValue}`}
                  active={shell.view === 'mail'}
                  selfUin={user.identityValue}
                  onUnreadChange={setMailUnread}
                  preferences={
                    mailPreferences.isFetchedAfterMount ? mailPreferences.data : undefined
                  }
                  onOpenRequested={openMailView}
                  searchTarget={mailSearchTarget}
                />
                {shell.view === 'qzone' ? (
                  <QzoneWorkspace
                    key={user.identityValue}
                    active={shell.view === 'qzone' && !arkFeedState}
                    readEnabled={qzonePageReady}
                    selfUin={user.identityValue}
                    nickname={user.displayName}
                    spaceRequest={qzoneSpaceRequest}
                    onSpaceChange={setCurrentQzoneUin}
                  />
                ) : null}
                {assistantVisited ? (
                  <AssistantConversationPane
                    accountScope={messageScope}
                    sessionId={assistantSessionId}
                    deletedSessionIds={deletedAssistantSessions}
                    searchTarget={assistantSearchTarget}
                    active={
                      shell.view === 'messages' &&
                      specialChat === 'assistant' &&
                      (!mobileLayout || !mobileConversationList)
                    }
                    onBackToDirectory={() => setMobileConversationList(true)}
                    onSessionCreated={(id) => {
                      setAssistantSessionId(id);
                      void utils.account.listAssistantSessions.invalidate();
                    }}
                    onNewSession={() => void createAssistantConversation()}
                  />
                ) : null}
                <RetainedTabs snapshotKey="main" activeKey={shell.view}>
                  <TabActivity active={!mobileLayout || fullBleedView || !mobileConversationList}>
                    {shell.view === 'messages' &&
                    specialChat === 'assistant' ? null : shell.view === 'messages' &&
                      specialChat === 'guild' ? (
                      <GuildDirectDialog
                        open
                        embedded
                        chatOnly
                        selfUser={user}
                        renderers={messageRenderers}
                        searchTarget={guildSearchTarget}
                        onActiveSessionChange={setActiveGuildNodeId}
                        onClose={() => {
                          setMobileConversationList(true);
                        }}
                      />
                    ) : shell.view === 'messages' && arkFeedState ? (
                      <OfficialConversationPane
                        user={user}
                        conversationId={arkFeedState.conversationId}
                        anchorId={arkFeedState.anchorId}
                        title={arkFeedState.title}
                        onBack={() => {
                          if (mobileLayout) setMobileConversationList(true);
                          else setArkFeedState(null);
                        }}
                        onEditMessage={async (msgId: string) => {
                          try {
                            const result = await client.account.getRawElements.query({ msgId });
                            if (result) {
                              setEditorState({ msgId, elements: result.elements });
                            }
                          } catch (e) {
                            console.error('[MainView] Failed to fetch raw elements:', e);
                          }
                        }}
                      />
                    ) : shell.view === 'home' ? (
                      <ChatHome nickname={user.displayName} avatarUrl={user.avatarUrl} />
                    ) : shell.view === 'agentlab' ? (
                      <Suspense fallback={workspaceLoading}>
                        <AgentLabView
                          searchTarget={cloneSearchTarget}
                          openTarget={virtualOpen}
                          createRequest={cloneCreateRequest}
                          openGroupRequest={cloneGroupRequest}
                          embedded
                          onConversationCreated={(target) => {
                            setVirtualOpen({ ...target, revision: Date.now() });
                            setConversationLocate({
                              id: `virtual:${target.kind}:${target.id}`,
                              revision: Date.now(),
                            });
                            setConversationView('clone');
                          }}
                          onBackToDirectory={() => {
                            if (mobileLayout) {
                              setMobileConversationList(true);
                              return;
                            }
                            setVirtualOpen(null);
                            shell.backConversation();
                            shell.switchView('messages');
                          }}
                        />
                      </Suspense>
                    ) : shell.view === 'collections' ? (
                      <CollectionDialog
                        open
                        embedded
                        searchTarget={collectionSearchTarget}
                        onClose={() => shell.switchView('messages')}
                      />
                    ) : shell.view === 'qzone' || shell.view === 'mail' ? null : shell.view ===
                        'channel' || shell.view === 'guild-direct' ? (
                      <ChannelView
                        key={messageScope}
                        initialDirectOpen={shell.view === 'guild-direct'}
                        onOpenDirect={() => {
                          setMobileConversationList(true);
                          changeConversationView('guild');
                          shell.switchView('messages');
                        }}
                      />
                    ) : shell.view === 'contacts' && shell.contactNotice === 'friend' ? (
                      <ContactNoticeDialog
                        open
                        requests={contactRequests}
                        onClose={shell.backContactNotice}
                        onOpenProfile={(member, anchor) =>
                          setMemberCard({ member, anchor, groupContext: null })
                        }
                      />
                    ) : shell.view === 'contacts' && shell.contactNotice === 'group' ? (
                      <GroupNoticeDialog
                        open
                        requests={groupRequests}
                        onClose={shell.backContactNotice}
                        onOpenProfile={(member, anchor, group) =>
                          setMemberCard({ member, anchor, groupContext: group ?? null })
                        }
                        onOpenGroupProfile={(group, anchor) => {
                          const known = contactDirectoryConversations.find(
                            (item) => item.type === 'group' && item.id === group.code,
                          );
                          setMemberCard(null);
                          setNumberGroupCard({
                            accountUin: openedUin,
                            conversation:
                              known?.type === 'group'
                                ? known
                                : sharedGroupConversation({
                                    code: group.code,
                                    name: group.name || group.code,
                                    avatar: avatarFromGroupCode(group.code) ?? '',
                                  }),
                            detailsKnown: known?.type === 'group',
                            anchor,
                          });
                        }}
                      />
                    ) : shell.view === 'annual' ? (
                      <Suspense fallback={workspaceLoading}>
                        <AnnualReportView />
                      </Suspense>
                    ) : (
                      <div className="weq-template-main-wrap">
                        <div className="weq-readonly-chat">
                          <ChatMainContent
                            key={messageScope}
                            draftScope={messageScope || undefined}
                            onLoadOlder={requestOlderMessages}
                            onLoadNewer={requestNewerMessages}
                            hasOlder={hasOlder}
                            onTimelineElement={captureNativeTimeline}
                            user={user}
                            view={shell.view}
                            contactTab={shell.contactTab}
                            contactOverviewOpen={shell.contactOverviewOpen}
                            onBackContactOverview={shell.backContactOverview}
                            relationGraphSlot={
                              <Suspense fallback={workspaceLoading}>
                                <RelationGraphView onOpenMember={handleOpenGraphMember} />
                              </Suspense>
                            }
                            selectedContact={selectedContactForDetail}
                            onPreviewContactChat={(contact) =>
                              void previewPrivateChat(contact, 'contact')
                            }
                            contactPreviewContent={
                              privatePreview?.source === 'contact'
                                ? conversationPreviewContent
                                : null
                            }
                            contactWorkspaceTab={shell.contactWorkspaceTab}
                            onContactWorkspaceTabChange={shell.setContactWorkspaceTab}
                            selectedGroupConversation={selectedGroupConversationForDetail}
                            groupWorkspaceLocation={groupWorkspaceLocation ?? undefined}
                            activeConversation={
                              activeConversation?.type === 'merged' ? undefined : activeConversation
                            }
                            messages={templateMessages}
                            messageRenderers={messageRenderers}
                            loadingMessages={loadingInitialMessages}
                            loadingNewer={loadingNewerMessages}
                            initialReadingPosition={initialReadingPosition}
                            atLatest={anchoredToLatest}
                            latestMessageSeq={
                              recentContactsData.find(
                                (contact) => contact.targetUid === selectedUid,
                              )?.msgSeq
                            }
                            onPreviewLatest={(conversation) =>
                              void previewConversation(conversation, 'latest')
                            }
                            onJumpToLatest={async () => {
                              const selection = selectionRef.current;
                              const previousWindow = windowRef.current;
                              const account = user.identityValue;
                              if (!selection) return false;
                              try {
                                const page = await client.account.listLatest.query({
                                  ...messageBindingRef.current,
                                  readWindow: selection.readWindow,
                                  deferReplyMedia: true,
                                  kind: selection.kind === 'group' ? 'group' : 'c2c',
                                  conv: selection.id,
                                  limit: PAGE_SIZE,
                                });
                                if (
                                  selectionRef.current !== selection ||
                                  windowRef.current !== previousWindow ||
                                  useViewState.getState().openedUin !== account
                                )
                                  return false;
                                const rows = page.map(toMessageWire).reverse();
                                pendingScrollRestoreRef.current = null;
                                cachedScrollRef.current = null;
                                windowRef.current = {
                                  minSeq: rows[0]?.msgSeq ?? null,
                                  anchored: true,
                                };
                                setLoaded(rows);
                                setAnchoredToLatest(true);
                                setHasNewer(false);
                                setHasOlder(page.length >= PAGE_SIZE);
                                return true;
                              } catch (error) {
                                pushToast({
                                  tone: 'error',
                                  message: '无法定位到最新消息',
                                  source: conversationNotificationSource(selectedConversation),
                                  detail: error instanceof Error ? error.message : String(error),
                                });
                                return false;
                              }
                            }}
                            onReadCurrentConversation={(conv) => {
                              if (unreadSnapshotPendingRef.current?.convId !== conv.id)
                                void markVisibleConversationRead(conv);
                            }}
                            conversationPrefs={conversationPrefs}
                            drafts={drafts}
                            query={shell.query}
                            onBackContact={shell.backContact}
                            onBackGroup={shell.backGroup}
                            onLoadMoreGroupMembers={requestMoreGroupMembers}
                            groupMembersLoading={selectedGroupMembersLoading}
                            groupMembersError={selectedGroupMembersError}
                            groupMemberSearch={memberSearch}
                            onGroupMemberSearchChange={setMemberSearchKeyword}
                            onLoadMoreGroupMemberSearch={groupMemberSearch.loadMore}
                            profileLoading={groupDetail.isLoading}
                            sendAvailable={sendAvailable}
                            onSend={sendComposerMessage}
                            onStartOutgoingMessage={(message) => {
                              if (
                                message.conversationId === selectedConversation?.id &&
                                sendAvailable
                              )
                                outgoingQueue.current.start(message.id);
                            }}
                            onRepeatMessage={repeatMessage}
                            onResolveMentions={resolveMentions}
                            onSearchMentionMembers={async (query, conversation) => {
                              const result = await client.account.searchGroupMembers.query({
                                groupCode: conversation.id,
                                keyword: query,
                                limit: 200,
                                offset: 0,
                              });
                              return result.members.map(mapGroupMemberWire);
                            }}
                            onStartCall={startVoiceCall}
                            onSendArk={sendArkCard}
                            arkLocation={arkLocation}
                            arkContacts={arkContacts}
                            defaultSignupGroupCode={
                              selectedConversation?.type === 'group'
                                ? selectedConversation.group.identityValue
                                : undefined
                            }
                            onSendFlash={sendFlashTransfer}
                            onSendFlashPhoto={sendFlashPhoto}
                            onSendBubbleVideo={sendBubbleVideo}
                            onSendRedPacket={sendRedPacket}
                            onDraftChange={updateDraft}
                            onDraftClear={(_conversationId) => updateDraft(_conversationId, '')}
                            onBackConversation={shell.backConversation}
                            onEditRaw={handleEditRaw}
                            onDeleteMessage={handleDeleteMessage}
                            onDismissUnsentMessage={dismissUnsentOutgoing}
                            onOpenGroupAlbums={handleOpenGroupAlbums}
                            onOpenGroupFiles={handleOpenGroupFiles}
                            onOpenGroupAnnouncements={handleOpenGroupAnnouncements}
                            groupSidebarFeature={activeGroupSidebarPopover?.kind}
                            groupTodos={
                              selectedConversation?.type === 'group' ? (
                                <GroupTodos
                                  key={`${noticeAccountKey}:${selectedConversation.id}`}
                                  groupId={Number(selectedConversation.group.identityValue)}
                                  groupName={selectedConversation.group.name}
                                  onJumpToMessage={(sequence) =>
                                    jumpToConvSeq('group', selectedConversation.id, sequence)
                                  }
                                  popoverOpen={activeGroupSidebarPopover?.kind === 'todos'}
                                  onPopoverOpenChange={(open, anchor) => {
                                    if (open && anchor)
                                      toggleGroupSidebarPopover(
                                        'todos',
                                        selectedConversation,
                                        anchor,
                                      );
                                    else
                                      setGroupSidebarPopover((current) =>
                                        current?.kind === 'todos' ? null : current,
                                      );
                                  }}
                                  embedded
                                />
                              ) : undefined
                            }
                            onOpenGroupSign={handleOpenGroupSign}
                            onOpenGroupEssence={handleOpenGroupEssence}
                            onOpenGroupInfoDetail={handleOpenGroupInfoDetail}
                            onRenameGroupMember={handleRenameGroupMember}
                            onChangeGroupMemberTitle={handleChangeGroupMemberTitle}
                            onKickGroupMember={handleKickGroupMember}
                            onOpenConversationSettings={handleOpenConversationSettings}
                            onOpenGroupBug={handleOpenGroupBug}
                            onOpenGroupLeftMembers={handleOpenGroupLeftMembers}
                            groupBugOnline={groupBugStatus.data?.online ?? false}
                            onOpenGroupMember={handleOpenGroupMember}
                            onAddMessage={handleAddMessage}
                            onMergeForward={handleMergeForward}
                            onAddToComposition={handleAddToComposition}
                            onForwardMessages={(messages) =>
                              openSequentialForward(messages, selectedConversation ?? undefined)
                            }
                            onViewDeleted={handleViewDeleted}
                            onViewRecalled={handleViewRecalled}
                            messageRecords={conversationRecords}
                            onCloseMessageRecords={closeConversationRecords}
                            onOpenGapMessages={handleOpenGapMessages}
                            onLoadSelectionMessages={loadSelectionMessages}
                            onSearchChatRecords={handleSearchChatRecords}
                            onOpenRoamingBackfill={(conversation) => {
                              const target = conversationRoamingTarget(conversation);
                              if (target) handleRoamingTargets([target]);
                            }}
                            deletedIds={deletedIds}
                            hiddenDeletedIds={hiddenDeletedIds}
                            onRestoreMessage={(msgId) =>
                              handleRestoreMessage(msgId, selectedConversation)
                            }
                            unreadDock={
                              unreadDockRequestRef.current?.convId === unreadSelectionId
                                ? unreadDock
                                : null
                            }
                            seenUnreadHighlights={seenUnreadHighlights}
                            missingJumpSeq={missingJumpSeq}
                            resolvedGapIds={resolvedGaps}
                          />
                        </div>
                      </div>
                    )}
                  </TabActivity>
                </RetainedTabs>
              </WorkspaceContent>
            }
          />

          {editorState ? (
            <MsgElementEditor
              msgId={editorState.msgId}
              elements={editorState.elements}
              onClose={() => setEditorState(null)}
              onSave={handleSaveRaw}
            />
          ) : null}

          {settingsOpen ? (
            <SettingsDialog
              key={`settings:${messageScope}`}
              open={settingsOpen}
              navigationGuard={settingsNavigation.guard}
              onClose={() => setSettingsOpen(false)}
              initialSection={settingsSection}
              searchTarget={settingsSearchTarget}
              onOpenMaintenance={openMaintenance}
              onOpenRecalls={handleOpenRecallsAt}
              recallDetails={recalls.origin === 'settings' ? recalledView : null}
              onCloseRecalls={closeSettingsRecalls}
              isCurrentSource={() => messageScopeRef.current === messageScope}
            />
          ) : null}
          {maintenanceTool ? (
            <DataMaintenanceDialog
              key={`maintenance:${messageScope}`}
              source={messageScope}
              tool={maintenanceTool}
              account={{
                uin: openedUin ?? '',
                configId,
                name: user.displayName,
                avatarUrl: user.avatarUrl ?? '',
              }}
              onClose={() => {
                setMaintenanceTool(null);
              }}
            />
          ) : null}
          <RailAccountFooter
            currentUin={user.identityValue}
            currentName={user.displayName}
            currentAvatarUrl={user.avatarUrl}
            settingsButton={
              <WorkspaceSettingsButton
                onClick={() => {
                  setDressUpOpen(false);
                  setMaintenanceTool(null);
                  setSettingsSection(undefined);
                  setSettingsOpen(true);
                }}
              />
            }
          >
            {(controls) => (
              <CalendarNavigationContext.Provider value={locateCalendarMessage}>
                <WorkspaceTools
                  key={messageScope}
                  accountScope={messageScope}
                  footerControls={controls}
                  onOpenAssistant={(target) => {
                    changeConversationView('assistant');
                    if (target?.sessionId) openAssistantConversation(target.sessionId, target);
                    else if (directoryAssistant.data?.[0])
                      openAssistantConversation(directoryAssistant.data[0].id);
                    else void createAssistantConversation();
                  }}
                  onOpenClone={(id) => {
                    flushAllDirtyDrafts();
                    setCloneSearchTarget(null);
                    setMobileConversationList(false);
                    setVirtualOpen({ kind: 'persona', id, revision: Date.now() });
                    if (conversationView !== 'clone') changeConversationView('clone');
                    setSpecialChat(null);
                    shell.switchView('agentlab');
                  }}
                  currentConversation={
                    shell.view === 'messages' && !specialChat && !arkFeedState
                      ? activeConversation
                      : null
                  }
                  workspace={{
                    view: shell.view,
                    conversation:
                      shell.view === 'messages' && !specialChat && !arkFeedState
                        ? activeConversation
                        : null,
                    specialChat: shell.view === 'messages' ? specialChat : null,
                    assistantSessionId: specialChat === 'assistant' ? assistantSessionId : null,
                    officialFeed: shell.view === 'messages' ? arkFeedState : null,
                    contact: shell.view === 'contacts' ? (shell.selectedContact ?? null) : null,
                    groupConversation:
                      shell.view === 'contacts' ? (shell.selectedGroupConversation ?? null) : null,
                    spaceUin: shell.view === 'qzone' ? currentQzoneUin : null,
                    virtual:
                      shell.view === 'agentlab' && virtualOpen
                        ? {
                            kind: virtualOpen.kind,
                            ownerId: virtualOpen.id,
                            name:
                              virtualRows.find(
                                (row) =>
                                  row.kind === virtualOpen.kind && row.ownerId === virtualOpen.id,
                              )?.name ?? '',
                          }
                        : null,
                    guildNodeId:
                      shell.view === 'channel' || specialChat === 'guild'
                        ? activeGuildNodeId
                        : null,
                  }}
                  analysisRequest={analysisRequest}
                  roamingRequest={roamingRequest}
                  onOpenComposition={compositionWindow.open}
                  assistantSearchTarget={assistantSearchTarget}
                  searchRequest={toolSearchRequest}
                  onOpenAnalysis={(request) =>
                    setAnalysisReports((previous) => [...previous, request])
                  }
                />
              </CalendarNavigationContext.Provider>
            )}
          </RailAccountFooter>
          {groupResourceWindows}
          <QzoneAlbumDialog
            selfUin={user.identityValue}
            open={qzoneAlbumOpen}
            onClose={() => setQzoneAlbumOpen(false)}
            hostUin={user.identityValue}
          />
          {dressUpOpen ? (
            <DressUpDialog
              key={dressUpEmojiTarget?.revision ?? `dressup:${dressUpSearchKind}`}
              initialKind={dressUpEmojiTarget ? 'emoji' : dressUpSearchKind}
              initialEmojiPackId={dressUpEmojiTarget?.packId}
              initialEmojiPackName={dressUpEmojiTarget?.name}
              onClose={() => {
                setDressUpOpen(false);
                setDressUpEmojiTarget(null);
              }}
            />
          ) : null}
          {albumDialog ? (
            <GroupAlbumDialog
              key={`${albumDialog.groupCode}:${albumDialog.initialAlbumId ?? ''}:${albumDialog.searchRevision ?? ''}`}
              groupCode={albumDialog.groupCode}
              groupName={albumDialog.groupName}
              initialAlbumId={albumDialog.initialAlbumId}
              onClose={() => setAlbumDialog(null)}
            />
          ) : null}
          {groupFileDialog ? (
            <GroupFileDialog
              key={`${groupFileDialog.groupCode}:${groupFileDialog.initialFolderId ?? ''}:${groupFileDialog.initialFileId ?? ''}:${groupFileDialog.searchRevision ?? ''}`}
              groupCode={groupFileDialog.groupCode}
              groupName={groupFileDialog.groupName}
              initialFolderId={groupFileDialog.initialFolderId}
              initialFileId={groupFileDialog.initialFileId}
              onJumpToMessage={(sequence, messageId) =>
                jumpToConvSeq(
                  'group',
                  groupFileDialog.groupCode,
                  sequence,
                  false,
                  undefined,
                  messageId,
                )
              }
              onClose={() => setGroupFileDialog(null)}
            />
          ) : null}
          {groupSignDialog ? (
            <GroupSignDialog
              presentation="popover"
              anchor={groupSignDialog.anchor}
              groupCode={groupSignDialog.groupCode}
              groupName={groupSignDialog.groupName}
              onClose={() => setGroupSidebarPopover(null)}
            />
          ) : null}
          {announcementsDialog ? (
            <GroupAnnouncementsDialog
              presentation="popover"
              anchor={announcementsDialog.anchor}
              groupCode={announcementsDialog.groupCode}
              groupName={announcementsDialog.groupName}
              currentAnnouncement={
                selectedConversation?.type === 'group' &&
                selectedConversation.id === announcementsDialog.groupCode
                  ? selectedConversation.group?.announcement
                  : null
              }
              bulletins={((groupBulletins.data ?? []) as GroupBulletinWire[]).map(
                (bulletin, _index) => {
                  // publisherUid 可能是 UID（数据库）或 UIN（Web API），尝试两者匹配
                  const publisher = currentGroupMembers.find(
                    (m) =>
                      m.id === bulletin.publisherUid || m.identityValue === bulletin.publisherUid,
                  );
                  return {
                    ...bulletin,
                    publisherName: publisher?.displayName,
                    publisherAvatar: publisher?.avatarUrl ?? undefined,
                  };
                },
              )}
              onClose={() => setGroupSidebarPopover(null)}
            />
          ) : null}
          {convSettings && convSettings.ownerKey === messageScope ? (
            <ConversationSettingsDialog
              key={`${convSettings.ownerKey}:${convSettings.kind}:${convSettings.conv}:${convSettings.initialSection ?? 'qq'}`}
              initialSection={convSettings.initialSection}
              kind={convSettings.kind}
              conv={convSettings.conv}
              title={convSettings.title}
              anchor={convSettings.anchor}
              members={(convSettings.groupConversation?.members ?? []).map((m) => ({
                uid: m.id,
                displayName: m.displayName,
                avatarUrl: m.avatarUrl ?? null,
                uin: m.uin,
                role: m.role,
              }))}
              onClose={() => setConvSettings(null)}
            />
          ) : null}
          {remarkTarget && (
            <QQRemarkDialog
              key={`${remarkTarget.kind}:${remarkTarget.conv}`}
              target={remarkTarget}
              onClose={() => setRemarkTarget(null)}
            />
          )}
          {groupBugDialog ? (
            <GroupBugDialog
              groupId={groupBugDialog.groupCode}
              groupName={groupBugDialog.groupName}
              onClose={() => setGroupBugDialog(null)}
            />
          ) : null}
          {groupLeftMembersDialog ? (
            <GroupLeftMembersDialog
              groupCode={groupLeftMembersDialog.groupCode}
              groupName={groupLeftMembersDialog.groupName}
              members={groupLeftMemberRows}
              loading={groupLeftMembers.isFetching}
              error={groupLeftMembers.error ? (groupLeftMembers.error.message ?? '查询失败') : null}
              onClose={() => setGroupLeftMembersDialog(null)}
            />
          ) : null}
          {groupTitleDialog ? (
            <GroupMemberTitleDialog
              key={`${groupTitleDialog.groupCode}:${groupTitleDialog.uid}`}
              groupCode={groupTitleDialog.groupCode}
              uid={groupTitleDialog.uid}
              memberName={groupTitleDialog.name}
              onClose={() => setGroupTitleDialog(null)}
            />
          ) : null}
          {groupMemberDialog?.kind === 'rename' ? (
            <GroupMemberRenameDialog
              memberName={groupMemberDialog.name}
              initialCard={groupMemberDialog.initialCard}
              busy={renameGroupMember.isLoading}
              onCancel={() => setGroupMemberDialog(null)}
              onConfirm={submitGroupMemberRename}
            />
          ) : null}
          {groupMemberDialog?.kind === 'kick' ? (
            <GroupMemberKickDialog
              memberName={groupMemberDialog.name}
              busy={kickGroupMember.isLoading}
              onCancel={() => setGroupMemberDialog(null)}
              onConfirm={submitGroupMemberKick}
            />
          ) : null}
          {essenceDialog ? (
            <GroupEssenceDialog
              presentation="popover"
              anchor={essenceDialog.anchor}
              groupCode={essenceDialog.groupCode}
              groupName={essenceDialog.groupName}
              essenceMessages={(() => {
                const essence = (
                  selectedUid === essenceDialog.groupCode ? (groupEssence.data ?? []) : []
                ) as GroupEssenceWire[];
                const essenceWeb =
                  selectedUid === essenceDialog.groupCode ? (groupEssenceWeb.data ?? []) : [];
                return projectGroupEssence(essence, essenceWeb, completeOnlineEssence);
              })()}
              loading={groupEssence.isLoading || groupEssenceWeb.isLoading}
              onlineError={groupEssenceWeb.isError}
              onClose={() => setGroupSidebarPopover(null)}
              onJumpToMessage={(seq) => {
                setGroupSidebarPopover(null);
                if (seq == null) {
                  console.warn('[essence-jump] missing msgSeq, cannot jump', seq);
                  return;
                }
                jumpToSeq({ seq });
              }}
            />
          ) : null}
          {numberGroupCard && numberGroupCard.accountUin === openedUin ? (
            <GroupProfileDialog
              conversation={numberGroupCard.conversation}
              anchor={numberGroupCard.anchor}
              detailsKnown={numberGroupCard.detailsKnown ?? false}
              onClose={() => setNumberGroupCard(null)}
            />
          ) : null}
          {conversationIdentity ? (
            <ConversationIdentityCard
              conversation={conversationIdentity.conversation}
              virtual={virtualRows.find((row) => row.id === conversationIdentity.conversation.id)}
              anchor={conversationIdentity.anchor}
              onClose={() => setConversationIdentity(null)}
            />
          ) : null}
          {memberCard ? (
            <MemberProfileCard
              member={memberCard.member}
              anchor={memberCard.anchor}
              groupCode={
                memberCard.groupContext !== undefined
                  ? memberCard.groupContext?.code
                  : (memberCard.groupCode ??
                    (!memberCard.fromSpace && selectedConversation?.type === 'group'
                      ? selectedConversation.id
                      : undefined))
              }
              groupName={
                memberCard.groupContext !== undefined
                  ? memberCard.groupContext?.name
                  : (memberCard.groupName ??
                    (!memberCard.fromSpace && selectedConversation?.type === 'group'
                      ? selectedConversation.group.name
                      : undefined))
              }
              onClose={() => setMemberCard(null)}
              onAnalyze={(target) => {
                setMemberCard(null);
                setAnalysisRequest((previous) => ({
                  target,
                  revision: (previous?.revision ?? 0) + 1,
                }));
              }}
              onOpenChat={() => {
                void openProfileChat({ kind: 'direct', user: memberCard.member }).catch(() =>
                  pushToast({
                    tone: 'info',
                    durationKind: 'failure',
                    title: '暂时无法打开私聊，请稍后重试',
                    source: notificationOrigin,
                  }),
                );
              }}
              onPreviewChat={() => void previewPrivateChat(memberCard.member)}
              previewContent={
                privatePreview?.source === 'member' ? conversationPreviewContent : null
              }
            />
          ) : null}
          {addMessageConv ? (
            <AddMessageModal
              conversation={addMessageConv}
              selfUser={user}
              selfUid={selfProfile.data?.uid}
              onClose={() => setAddMessageConv(null)}
              onInserted={() => void refreshWindow()}
            />
          ) : null}
          {mergeForwardDraft ? (
            <MergeForwardDialog
              key={`${mergeForwardDraft.draft.id}:${mergeForwardDraft.draft.version ?? ''}`}
              initialDraft={mergeForwardDraft.draft}
              self={mergeForwardSelf}
              senderMode={mergeForwardDraft.senderMode}
              members={mergeForwardDraft.members}
              targets={mergeForwardTargets}
              sendAvailable={mergeForwardSendAvailable}
              onClose={() => setMergeForwardDraft(null)}
              onPersist={persistMergeForwardDraft}
              onForward={forwardMergeDraft}
            />
          ) : null}
          <CompositionWorkspace
            popup={compositionWindow.popup}
            fallback={compositionWindow.fallback}
            onPopOut={compositionWindow.open}
            self={mergeForwardSelf}
            targets={mergeForwardTargets}
            sendAvailable={mergeForwardSendAvailable}
            onClose={compositionWindow.close}
            onForward={forwardMergeDraft}
            onOpenTarget={openForwardTarget}
            onSend={(message, target, signal, binding) =>
              forwardMessage(
                message,
                target,
                signal,
                user.identityValue,
                binding.expectedAccountConfigId,
              )
            }
          />
          {floatingPreview ? conversationPreviewContent : null}
          {specialPreview && messageBindingRef.current ? (
            <SpecialConversationPreview
              key={specialPreview.id}
              conversation={specialPreview}
              binding={messageBindingRef.current}
              user={user}
              virtual={virtualRows}
              renderers={messageRenderers}
              onClose={() => setSpecialPreview(null)}
              onLocateMessage={(message) => {
                setSpecialPreview(null);
                locateCalendarMessage(calendarTargetForConversation(specialPreview), {
                  id: message.msgId || message.id,
                  seq: String(message.msgSeq ?? ''),
                  time: (Date.parse(message.createdAt) || 0) / 1000,
                });
              }}
            />
          ) : null}
          {unplacedRoaming ? (
            <GapMessagesModal
              conversation={unplacedRoaming.conversation}
              user={user}
              messages={unplacedRoaming.messages.map((row) =>
                messageToTemplate(
                  row,
                  unplacedRoaming.conversation,
                  user,
                  undefined,
                  botUids,
                  undefined,
                  profileByUid,
                ),
              )}
              renderers={messageRenderers}
              loading={false}
              loadingMore={false}
              error={null}
              hasMore={false}
              moreFailed={false}
              totalCount={unplacedRoaming.messages.length}
              notice="这些记录缺少已确认的 NT 会话序号，仅单独展示，未混入主时间线。"
              onLoadMore={noopAsync}
              onClose={() => setUnplacedRoaming(null)}
            />
          ) : null}
          {forwardBatch &&
          forwardBatch.account === user.identityValue &&
          forwardBatch.configId === configId ? (
            <SequentialForwardDialog
              messages={forwardBatch.messages}
              conversation={forwardBatch.conversation}
              user={user}
              renderers={messageRenderers}
              targets={mergeForwardTargets}
              onSend={(message, target, signal) =>
                forwardMessage(message, target, signal, forwardBatch.account, forwardBatch.configId)
              }
              onOpenTarget={openForwardTarget}
              onClose={() => setForwardBatch(null)}
            />
          ) : null}
          {analysisReports.map((request) => (
            <Suspense key={request.id} fallback={workspaceLoading}>
              <AnalysisReportPage
                request={request}
                onClose={() =>
                  setAnalysisReports((previous) =>
                    previous.filter((item) => item.id !== request.id),
                  )
                }
              />
            </Suspense>
          ))}
          {overviewCalendar ? (
            <ConversationOverviewCalendar
              targets={overviewCalendarTargets}
              sourceRevision={`${dbRevisionRef.current}:${calendarDataRevision}:${calendarCloneRevision(directoryPersonas.data ?? [], directoryGroups.data ?? [])}:${calendarAssistantRevision(directoryAssistant.data ?? [])}`}
              scope={conversationView}
              query={overviewCalendar.query}
              ready={currentViewCalendarReady}
              directoryError={
                currentViewError ? `当前视图部分目录读取失败：${currentViewError}` : undefined
              }
              binding={pinSession.binding}
              onClose={() => setOverviewCalendar(null)}
              onLocate={locateCalendarMessage}
            />
          ) : null}
          {chatRecordsTarget ? (
            <ChatRecordsModal
              initialHit={chatRecordsTarget.hit}
              initialKeyword={chatRecordsTarget.keyword}
              fixed={chatRecordsTarget.fixed}
              renderers={messageRenderers}
              user={user}
              groupMembers={memberMapForGroup}
              resolveGroupMembers={resolveRecordsMembers}
              onClose={() => setChatRecordsTarget(null)}
              onJumpMessage={({ source, targetUid, msgSeq, msgId }) =>
                jumpToConvSeq(
                  source === 'group' ? 'group' : 'c2c',
                  targetUid,
                  msgSeq,
                  false,
                  undefined,
                  msgId,
                )
              }
            />
          ) : null}
        </ConvContext.Provider>
      </ForwardKindContext.Provider>
    </ReplyJumpContext.Provider>
  );
  const previousDirectoryIds = useRef<string[]>([]);
  const contactDirectoryIds = useMemo(() => {
    const ids =
      shell.contactTab === 'friends'
        ? [
            ...buddyContacts,
            ...specialContactSections.flatMap((section) => section.items),
            ...historicalContactSections.flatMap((section) => section.items),
          ]
            .filter(
              (contact) =>
                !contactDirectoryQuery ||
                `${displayUserName(contact)} ${'nick' in contact ? (contact.nick ?? '') : ''} ${contact.identityValue}`
                  .toLocaleLowerCase()
                  .includes(contactDirectoryQuery.trim().toLocaleLowerCase()),
            )
            .map((contact) => contact.id)
        : contactDirectoryConversations
            .filter(
              (conversation) =>
                conversation.type === 'group' &&
                (!contactDirectoryQuery ||
                  `${conversation.group.name} ${conversation.group.remark ?? ''} ${conversation.id}`
                    .toLocaleLowerCase()
                    .includes(contactDirectoryQuery.trim().toLocaleLowerCase())),
            )
            .map((conversation) => conversation.id);
    const previous = previousDirectoryIds.current;
    return previous.length === ids.length && previous.every((id, index) => id === ids[index])
      ? previous
      : ids;
  }, [
    shell.contactTab,
    buddyContacts,
    specialContactSections,
    historicalContactSections,
    contactDirectoryConversations,
    contactDirectoryQuery,
  ]);
  useLayoutEffect(() => {
    previousDirectoryIds.current = contactDirectoryIds;
  }, [contactDirectoryIds]);
  const contactDirectoryValue = useMemo(
    () => ({
      query: contactDirectoryQuery,
      onQuery: setContactDirectoryQuery,
      ids: contactDirectoryIds,
    }),
    [contactDirectoryQuery, contactDirectoryIds],
  );
  const profileNavigation = useCallback<
    NonNullable<React.ContextType<typeof ProfileNavigationContext>>
  >((member, anchor, group) => setMemberCard({ member, anchor, groupContext: group ?? null }), []);
  // 消息刷新不重建来源回调，避免重置正在等待读回的提示与计时。
  const notificationContactId = shell.selectedContact?.id;
  const notificationGroupId = shell.selectedGroupConversation?.id;
  const notificationConversationId = selectedConversation?.id;
  const notificationConversationKind = selectedConversation?.type === 'group' ? 'group' : 'c2c';
  const notificationOrigin = useMemo(() => {
    if (memberCard) return restoreNotificationSource(memberCard, setMemberCard);
    if (groupMemberDialog)
      return restoreNotificationSource(groupMemberDialog, setGroupMemberDialog);
    if (groupTitleDialog) return restoreNotificationSource(groupTitleDialog, setGroupTitleDialog);
    if (remarkTarget) return restoreNotificationSource(remarkTarget, setRemarkTarget);
    if (convSettings) return restoreNotificationSource(convSettings, setConvSettings);
    if (groupFileDialog) return restoreNotificationSource(groupFileDialog, setGroupFileDialog);
    if (albumDialog) return restoreNotificationSource(albumDialog, setAlbumDialog);
    if (groupBugDialog) return restoreNotificationSource(groupBugDialog, setGroupBugDialog);
    if (shell.view === 'contacts' && shell.contactNotice)
      return notificationSource({
        kind: 'contact-notice',
        notice: shell.contactNotice,
      });
    if (shell.view === 'contacts' && notificationContactId)
      return notificationSource({
        kind: 'contact',
        id: notificationContactId,
        tab: shell.contactWorkspaceTab,
      });
    if (shell.view === 'contacts' && notificationGroupId)
      return notificationSource({ kind: 'group', id: notificationGroupId });
    if (shell.view === 'messages' && notificationConversationId)
      return notificationSource({
        kind: 'conversation',
        conversationKind: notificationConversationKind,
        conv: notificationConversationId,
      });
    return notificationSource({ kind: 'app', target: { kind: 'view', view: shell.view } });
  }, [
    messageScope,
    memberCard,
    groupMemberDialog,
    groupTitleDialog,
    remarkTarget,
    convSettings,
    groupFileDialog,
    albumDialog,
    groupBugDialog,
    shell.view,
    shell.contactNotice,
    notificationContactId,
    shell.contactWorkspaceTab,
    notificationGroupId,
    notificationConversationId,
    notificationConversationKind,
  ]);
  return notificationContent(
    notificationOrigin,
    <ConversationSettingsNavigationContext.Provider value={openProfileConversationSettings}>
      <GroupResourceNavigationContext.Provider value={openGroupResourceWindow}>
        <CalendarNavigationContext.Provider value={locateCalendarMessage}>
          <ContactWorkspaceNavigationContext.Provider
            value={(target) =>
              settingsNavigation.navigate(() => {
                if (shell.view === 'messages') flushAllDirtyDrafts();
                setMemberCard(null);
                setPrivatePreview(null);
                if (target.kind === 'person') {
                  const contact = profileContacts.find(
                    (person) =>
                      person.id === target.contact.id ||
                      (person.identityLabel === 'QQ' &&
                        person.identityValue === target.contact.identityValue),
                  );
                  shell.openContactDetails(
                    {
                      ...target.contact,
                      ...contact,
                      profileContext: target.group
                        ? {
                            groupCode: target.group.code,
                            groupName: target.group.name,
                            member: target.contact.profileContext?.member,
                          }
                        : target.contact.profileContext,
                    },
                    target.tab,
                  );
                } else {
                  setGroupWorkspaceLocation({
                    code: target.conversation.id,
                    section: target.section ?? 'profile',
                    albumId: target.albumId,
                    folderId: target.folderId,
                    fileId: target.fileId,
                  });
                  const known = contactDirectoryConversations.find(
                    (conversation) =>
                      conversation.type === 'group' && conversation.id === target.conversation.id,
                  );
                  shell.openGroupDetails(known?.type === 'group' ? known : target.conversation);
                }
              })
            }
          >
            <ProfileNavigationGuardContext.Provider value={settingsNavigation.register}>
              <ProfileNavigationContext.Provider value={profileNavigation}>
                <QzoneNavigationContext.Provider
                  value={(uin, nickname) => {
                    if (!/^[1-9]\d{4,19}$/.test(uin)) return;
                    if (shell.view === 'messages') flushAllDirtyDrafts();
                    setArkFeedState(null);
                    setQzoneSpaceRequest({
                      accountUin: user.identityValue,
                      uin,
                      nickname,
                      revision: crypto.randomUUID(),
                    });
                    shell.switchView('qzone');
                  }}
                >
                  <QzoneProfileContext.Provider
                    value={(uin, nickname, anchor) => {
                      const contact = buddyContacts.find((person) => person.identityValue === uin);
                      const profile = [...profileByUid.values()].find(
                        (person) => person.uin === uin,
                      );
                      const conversation = [
                        ...conversations,
                        ...hiddenConversationsById.values(),
                        ...deletedConversationsById.values(),
                      ].find(
                        (conv) => conv.type === 'direct' && conv.otherUser.identityValue === uin,
                      );
                      const peer = conversation?.type === 'direct' ? conversation.otherUser : null;
                      setMemberCard({
                        member: contact ??
                          peer ?? {
                            id: profile?.uid || '',
                            identityLabel: 'QQ',
                            identityValue: uin,
                            username: profile?.uid || uin,
                            displayName: profile?.nick || nickname || uin,
                            avatarUrl: senderAvatarSrc(uin) || null,
                          },
                        anchor,
                        fromSpace: true,
                      });
                    }}
                  >
                    <ChatNavigationContext.Provider
                      value={(target) => {
                        void openProfileChat(target).catch(() =>
                          pushToast({
                            tone: 'info',
                            durationKind: 'failure',
                            title: '暂时无法打开会话，请稍后重试',
                            source: notificationOrigin,
                          }),
                        );
                      }}
                    >
                      <QzoneCardNavigationContext.Provider
                        value={(target) => {
                          flushAllDirtyDrafts();
                          setArkFeedState(null);
                          setQzoneSpaceRequest({
                            accountUin: user.identityValue,
                            uin: target.uin,
                            nickname:
                              target.uin === user.identityValue
                                ? user.displayName
                                : buddyContacts.find(
                                    (person) => person.identityValue === target.uin,
                                  )?.displayName,
                            target,
                            revision: crypto.randomUUID(),
                          });
                          shell.switchView('qzone');
                        }}
                      >
                        <ConversationDirectoryContext.Provider
                          value={useEventContextValue<
                            NonNullable<React.ContextType<typeof ConversationDirectoryContext>>
                          >({
                            real: conversations,
                            profileConversationExists: (person) => {
                              const id = person.uid || person.id;
                              return (
                                conversations.some(
                                  (item) =>
                                    item.id === id ||
                                    (item.type === 'direct' &&
                                      item.otherUser.identityValue === person.identityValue),
                                ) ||
                                hiddenConversationsById.has(id) ||
                                deletedConversationsById.has(id) ||
                                Boolean(temporaryConversations[id])
                              );
                            },
                            guild: guildConversationRows,
                            view: conversationView,
                            views: conversationViews,
                            rows: currentViewRows,
                            returnToRegular,
                            onViewChange: switchConversationView,
                            onReturnToRegular: () => switchConversationView('regular'),
                            onAssistant: (id) => openAssistantConversation(id),
                            onCreateAssistant: () => void createAssistantConversation(),
                            onDelete: deleteAiConversations,
                            deleteBusy: deletingAi,
                            onRetry: () => {
                              for (const query of currentViewQueries) void query.refetch();
                            },
                            onExportBatch: exportConversationRows,
                            preferences: currentViewPreferences,
                            showContactUnreadCount:
                              displaySettings.data?.showContactUnreadCount ?? false,
                            groupAssistantIds,
                            loadingError: currentViewError,
                            virtual: virtualRows,
                            locate: conversationLocate,
                            onListInteraction: unreadConversationCycle.reset,
                            onAnalyze: handleAnalyzeConversation,
                            onOpenProfile: openConversationProfile,
                            onPreview: previewMenuConversation,
                            onMuteGenerated: (conversation, muted) => {
                              if (
                                !conversation.generated ||
                                !messageScope ||
                                currentAccountScope() !== messageScope
                              )
                                return;
                              void patchAccountRecords('notifications', {
                                [generatedMuteKey(conversation.id)]: muted,
                              }).catch((error) => {
                                if (messageScopeRef.current !== messageScope) return;
                                pushToast({
                                  tone: 'error',
                                  title: '免打扰保存失败',
                                  detail: String(error),
                                });
                              });
                            },
                            onPin: (conversation, pinned) => {
                              if (
                                conversationView === 'groupAssistant' &&
                                conversation.type === 'group'
                              ) {
                                const next = { ...groupAssistantPins, [conversation.id]: pinned };
                                try {
                                  saveGroupAssistantPins(user.identityValue, next);
                                  setGroupAssistantPins(next);
                                } catch (error) {
                                  pushToast({
                                    tone: 'error',
                                    title: '群助手置顶保存失败',
                                    source: conversationNotificationSource(conversation),
                                    detail: error instanceof Error ? error.message : String(error),
                                  });
                                }
                              } else
                                updateConversationPreference(conversation.id, 'pinned', pinned);
                            },
                            onEditRemark: (conversation) => {
                              const target = conversationRoamingTarget(conversation);
                              if (target) setRemarkTarget(target);
                            },
                            onAnalyzeMember: (conversation, member) => {
                              setAnalysisRequest((previous) => ({
                                target: {
                                  kind: 'member',
                                  groupCode: conversation.group.id,
                                  memberUid: member.id.startsWith('u_') ? member.id : '',
                                  memberUin: member.identityValue || undefined,
                                },
                                revision: (previous?.revision ?? 0) + 1,
                              }));
                            },
                            onRoaming: handleRoamingTargets,
                            onReadState: (rows, unread) =>
                              void changeConversationReadState(rows, unread),
                            readStateBusy,
                            onVisibleConversations: (rows) =>
                              prefetchVisible(
                                rows.filter(
                                  (row) =>
                                    row.type !== 'merged' &&
                                    !row.generated &&
                                    (!row.directoryKind || row.directoryKind === 'qq'),
                                ),
                              ),
                            onConversationIntent: (row) => {
                              if (
                                !row.generated &&
                                (!row.directoryKind || row.directoryKind === 'qq')
                              )
                                prefetchIntent(row);
                            },
                            onCalendar: (query) => setOverviewCalendar({ query }),
                            onVirtual: (item) => {
                              flushAllDirtyDrafts();
                              setMobileConversationList(false);
                              setCloneSearchTarget(null);
                              setVirtualOpen({
                                kind: item.kind,
                                id: item.ownerId,
                                revision: Date.now(),
                              });
                              setSpecialChat(null);
                              setArkFeedState(null);
                              shell.switchView('agentlab');
                            },
                            onCreate: handleCreateClone,
                            onCreateGroup: () => {
                              flushAllDirtyDrafts();
                              setMobileConversationList(false);
                              setCloneGroupRequest((current) => current + 1);
                              changeConversationView('clone', conversationView === 'regular');
                              setSpecialChat(null);
                              shell.switchView('agentlab');
                            },
                          })}
                        >
                          <FriendDirectoryControls>
                            <ContactDirectoryContext.Provider value={contactDirectoryValue}>
                              <WorkspacePages
                                suspended={shell.profileReturnPending}
                                navigationKey={`${shell.view}:${shell.activeConversationId ?? ''}:${shell.selectedContactId ?? ''}:${shell.selectedGroupConversationId ?? ''}:${surfaceNavigation}`}
                                onNavigate={() => {
                                  setSettingsOpen(false);
                                  setConvSettings(null);
                                  setRemarkTarget(null);
                                }}
                              >
                                <RendererRecoveryNotice
                                  ready={
                                    Boolean(messageScope) &&
                                    !loadingInitialMessages &&
                                    (!shell.activeConversationId ||
                                      (Boolean(selectedConversation) &&
                                        (loaded.length > 0 || windowVerifiedAtRef.current > 0)))
                                  }
                                />
                                <GroupAlbumCardNavigationProvider binding={pinSession.binding}>
                                  <RelationshipDirectoryContext.Provider
                                    value={relationshipDirectory}
                                  >
                                    <GroupMessagePreviewContext.Provider
                                      value={useEventContextValue<
                                        NonNullable<
                                          React.ContextType<typeof GroupMessagePreviewContext>
                                        >
                                      >({
                                        open: (conversation) =>
                                          void previewConversation(conversation, 'group-profile'),
                                        close: () => {
                                          previewRequest.current++;
                                          setPrivatePreview(null);
                                        },
                                        conversationId:
                                          privatePreview?.source === 'group-profile'
                                            ? privatePreview.conversation.id
                                            : null,
                                        content:
                                          privatePreview?.source === 'group-profile'
                                            ? conversationPreviewContent
                                            : null,
                                      })}
                                    >
                                      <GroupSpeechPreviewContext.Provider
                                        value={useEventContextValue<
                                          NonNullable<
                                            React.ContextType<typeof GroupSpeechPreviewContext>
                                          >
                                        >({
                                          open: (person, source) => {
                                            const group = person.profileContext;
                                            if (!group) return;
                                            const known = conversations.find(
                                              (item) =>
                                                item.type === 'group' &&
                                                item.id === group.groupCode,
                                            );
                                            const conversation =
                                              known?.type === 'group'
                                                ? known
                                                : sharedGroupConversation({
                                                    code: group.groupCode,
                                                    name: group.groupName || group.groupCode,
                                                    avatar:
                                                      avatarFromGroupCode(group.groupCode) ?? '',
                                                  });
                                            void previewConversation(
                                              {
                                                ...conversation,
                                                members: [
                                                  ...conversation.members.filter(
                                                    (member) => member.id !== person.id,
                                                  ),
                                                  {
                                                    ...person,
                                                    nick: person.nick ?? undefined,
                                                    remark: person.remark ?? undefined,
                                                    role: group.member?.role ?? 'member',
                                                    joinedAt: group.member?.joinedAt ?? '',
                                                    card: group.member?.card,
                                                  },
                                                ],
                                              },
                                              source === 'contact' ? 'contact' : 'speech',
                                              person.uid || person.id,
                                            );
                                          },
                                          close: () => {
                                            previewRequest.current++;
                                            setPrivatePreview(null);
                                          },
                                        })}
                                      >
                                        {chatContent}
                                      </GroupSpeechPreviewContext.Provider>
                                    </GroupMessagePreviewContext.Provider>
                                  </RelationshipDirectoryContext.Provider>
                                </GroupAlbumCardNavigationProvider>
                              </WorkspacePages>
                            </ContactDirectoryContext.Provider>
                          </FriendDirectoryControls>
                        </ConversationDirectoryContext.Provider>
                      </QzoneCardNavigationContext.Provider>
                      <ForwardWindowHost
                        key={messageScope}
                        actions={{
                          binding: pinSession.binding,
                          sendAvailable,
                          forward: openSequentialForward,
                          merge: handleSnapshotMerge,
                          addMaterial: handleAddToComposition,
                        }}
                      />
                    </ChatNavigationContext.Provider>
                  </QzoneProfileContext.Provider>
                </QzoneNavigationContext.Provider>
                {/* 通话窗口盖在最上层：它是一次性的模态浮层，与主界面的浮层栈无关。 */}
                {activeCall ? (
                  <CallWindow initial={activeCall} onClose={() => setActiveCall(null)} />
                ) : null}
              </ProfileNavigationContext.Provider>
            </ProfileNavigationGuardContext.Provider>
          </ContactWorkspaceNavigationContext.Provider>
        </CalendarNavigationContext.Provider>
      </GroupResourceNavigationContext.Provider>
    </ConversationSettingsNavigationContext.Provider>,
  );
}
