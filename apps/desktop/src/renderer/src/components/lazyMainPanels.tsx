import { lazy, Suspense, useEffect, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { lazyPanel } from '../lib/lazyPanel';
import { PanelLoading } from './LoadingIndicator';

const MailContent = lazy(() =>
  import('../views/MailView').then((module) => ({ default: module.MailWorkspace })),
);
export function MailWorkspace(props: ComponentProps<typeof MailContent>) {
  const requested = Boolean(
    props.active || props.preferences?.showUnread || props.preferences?.notifications,
  );
  const [visited, setVisited] = useState(requested);
  useEffect(() => {
    if (requested) setVisited(true);
  }, [requested]);
  return requested || visited ? (
    <Suspense fallback={props.active ? <PanelLoading /> : null}>
      <MailContent {...props} />
    </Suspense>
  ) : null;
}

const CompositionContent = lazy(() =>
  import('./mergeForward/CompositionWorkspace').then((module) => ({
    default: module.CompositionWorkspace,
  })),
);
export function CompositionWorkspace(props: ComponentProps<typeof CompositionContent>) {
  const requested = Boolean(props.popup || props.fallback || props.incoming?.length);
  const [visited, setVisited] = useState(requested);
  useEffect(() => {
    if (requested) setVisited(true);
  }, [requested]);
  if (!requested && !visited) return null;
  const loading = <PanelLoading />;
  return (
    <Suspense
      fallback={
        props.popup
          ? createPortal(loading, props.popup.document.body)
          : props.fallback
            ? loading
            : null
      }
    >
      <CompositionContent {...props} />
    </Suspense>
  );
}

export const QzoneAlbumDialog = lazyPanel<
  ComponentProps<typeof import('./QzoneAlbumDialog').QzoneAlbumDialog>
>(() => import('./QzoneAlbumDialog').then((m) => ({ default: m.QzoneAlbumDialog })));
export const GroupAlbumDialog = lazyPanel<
  ComponentProps<typeof import('./GroupAlbumDialog').GroupAlbumDialog>
>(() => import('./GroupAlbumDialog').then((m) => ({ default: m.GroupAlbumDialog })));
export const GroupAlbumFeedDialog = lazyPanel<
  ComponentProps<typeof import('./GroupAlbumFeedDialog').GroupAlbumFeedDialog>
>(() => import('./GroupAlbumFeedDialog').then((m) => ({ default: m.GroupAlbumFeedDialog })));
export const GroupFileDialog = lazyPanel<
  ComponentProps<typeof import('./GroupFileDialog').GroupFileDialog>
>(() => import('./GroupFileDialog').then((m) => ({ default: m.GroupFileDialog })));
export const GroupSignDialog = lazyPanel<
  ComponentProps<typeof import('./GroupSignDialog').GroupSignDialog>
>(() => import('./GroupSignDialog').then((m) => ({ default: m.GroupSignDialog })));
export const GroupEssenceDialog = lazyPanel<
  ComponentProps<typeof import('./GroupEssenceDialog').GroupEssenceDialog>
>(() => import('./GroupEssenceDialog').then((m) => ({ default: m.GroupEssenceDialog })));
export const GroupLeftMembersDialog = lazyPanel<
  ComponentProps<typeof import('./GroupLeftMembersDialog').GroupLeftMembersDialog>
>(() => import('./GroupLeftMembersDialog').then((m) => ({ default: m.GroupLeftMembersDialog })));
export const AddMessageModal = lazyPanel<
  ComponentProps<typeof import('./compose/AddMessageModal').AddMessageModal>
>(() => import('./compose/AddMessageModal').then((m) => ({ default: m.AddMessageModal })));
export const MergeForwardDialog = lazyPanel<
  ComponentProps<typeof import('./mergeForward/MergeForwardDialog').MergeForwardDialog>
>(() =>
  import('./mergeForward/MergeForwardDialog').then((m) => ({ default: m.MergeForwardDialog })),
);
export const DeletedMessagesModal = lazyPanel<
  ComponentProps<typeof import('./compose/DeletedMessagesModal').DeletedMessagesModal>
>(() =>
  import('./compose/DeletedMessagesModal').then((m) => ({ default: m.DeletedMessagesModal })),
);
export const RecalledMessagesModal = lazyPanel<
  ComponentProps<typeof import('./compose/RecalledMessagesModal').RecalledMessagesModal>
>(() =>
  import('./compose/RecalledMessagesModal').then((m) => ({ default: m.RecalledMessagesModal })),
);
export const GapMessagesModal = lazyPanel<
  ComponentProps<typeof import('./compose/GapMessagesModal').GapMessagesModal>
>(() => import('./compose/GapMessagesModal').then((m) => ({ default: m.GapMessagesModal })));
export const ChatRecordsModal = lazyPanel<
  ComponentProps<typeof import('./search/ChatRecordsModal').ChatRecordsModal>
>(() => import('./search/ChatRecordsModal').then((m) => ({ default: m.ChatRecordsModal })));
export const SequentialForwardDialog = lazyPanel<
  ComponentProps<typeof import('./SequentialForwardDialog').SequentialForwardDialog>
>(() => import('./SequentialForwardDialog').then((m) => ({ default: m.SequentialForwardDialog })));
export const MsgElementEditor = lazyPanel<
  ComponentProps<typeof import('./MsgElementEditor').MsgElementEditor>
>(() => import('./MsgElementEditor').then((m) => ({ default: m.MsgElementEditor })));
export const SearchResultsPanel = lazyPanel<
  ComponentProps<typeof import('./search/SearchResultsPanel').SearchResultsPanel>
>(() => import('./search/SearchResultsPanel').then((m) => ({ default: m.SearchResultsPanel })));
export const WorkspaceTools = lazyPanel<
  ComponentProps<typeof import('./WorkspaceTools').WorkspaceTools>
>(() => import('./WorkspaceTools').then((m) => ({ default: m.WorkspaceTools })));
export const ChatHome = lazyPanel<ComponentProps<typeof import('../views/ChatHome').ChatHome>>(() =>
  import('../views/ChatHome').then((m) => ({ default: m.ChatHome })),
);
export const CallWindow = lazyPanel<ComponentProps<typeof import('./CallWindow').CallWindow>>(() =>
  import('./CallWindow').then((m) => ({ default: m.CallWindow })),
);
export const OfficialConversationPane = lazyPanel<
  ComponentProps<typeof import('./OfficialConversationPane').OfficialConversationPane>
>(() =>
  import('./OfficialConversationPane').then((m) => ({ default: m.OfficialConversationPane })),
);
export const ContactNoticeDialog = lazyPanel<
  ComponentProps<typeof import('./ContactNoticeDialogs').ContactNoticeDialog>
>(() => import('./ContactNoticeDialogs').then((m) => ({ default: m.ContactNoticeDialog })));
export const GroupNoticeDialog = lazyPanel<
  ComponentProps<typeof import('./ContactNoticeDialogs').GroupNoticeDialog>
>(() => import('./ContactNoticeDialogs').then((m) => ({ default: m.GroupNoticeDialog })));
export const GroupAnnouncementsDialog = lazyPanel<
  ComponentProps<typeof import('./GroupAnnouncementsDialog').GroupAnnouncementsDialog>
>(() =>
  import('./GroupAnnouncementsDialog').then((m) => ({ default: m.GroupAnnouncementsDialog })),
);
export const ConversationSettingsDialog = lazyPanel<
  ComponentProps<typeof import('./ConversationSettingsDialog').ConversationSettingsDialog>
>(() =>
  import('./ConversationSettingsDialog').then((m) => ({ default: m.ConversationSettingsDialog })),
);
export const QQRemarkDialog = lazyPanel<
  ComponentProps<typeof import('./QQRemarkDialog').QQRemarkDialog>
>(() => import('./QQRemarkDialog').then((m) => ({ default: m.QQRemarkDialog })));
export const GroupMemberKickDialog = lazyPanel<
  ComponentProps<typeof import('./GroupMemberModerationDialogs').GroupMemberKickDialog>
>(() =>
  import('./GroupMemberModerationDialogs').then((m) => ({ default: m.GroupMemberKickDialog })),
);
export const GroupMemberRenameDialog = lazyPanel<
  ComponentProps<typeof import('./GroupMemberModerationDialogs').GroupMemberRenameDialog>
>(() =>
  import('./GroupMemberModerationDialogs').then((m) => ({ default: m.GroupMemberRenameDialog })),
);
export const GroupMemberTitleDialog = lazyPanel<
  ComponentProps<typeof import('./GroupMemberModerationDialogs').GroupMemberTitleDialog>
>(() =>
  import('./GroupMemberModerationDialogs').then((m) => ({ default: m.GroupMemberTitleDialog })),
);
export const ConversationOverviewCalendar = lazyPanel<
  ComponentProps<typeof import('./ConversationOverviewCalendar').ConversationOverviewCalendar>
>(() =>
  import('./ConversationOverviewCalendar').then((m) => ({
    default: m.ConversationOverviewCalendar,
  })),
);
