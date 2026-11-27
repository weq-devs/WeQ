import { lazy, Suspense, useEffect, useMemo, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { Images, X } from 'lucide-react';
import { lazyPanel } from '../lib/lazyPanel';
import type { OverlayAnchor } from '../lib/overlayAnchor.shared';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { Modal } from './Dialog';
import { DeferredSurfaceLoading } from './DeferredSurfaceLoading';
import { surfaceLoading } from './DeferredSurfaceLoading.shared';
import { LoadingIndicator, PanelLoading } from './LoadingIndicator';
import { GroupFeatureSurface, type GroupFeaturePresentation } from './GroupFeatureSurface';
import { OverlayLayer } from './OverlayLayer';
import { ChatRecordsHeader } from './search/ChatRecordsHeader';
import { ConversationRenderBoundary } from './ConversationRenderBoundary';
import '../styles/conversation-settings.css';
import '../styles/group-left-members.css';
import '../styles/group-sign.css';

const MailContent = lazy(() =>
  import('../views/MailView').then((module) => ({ default: module.MailWorkspace })),
);
export function MailWorkspace(props: ComponentProps<typeof MailContent>) {
  const [visited, setVisited] = useState(props.active);
  useEffect(() => {
    if (props.active) setVisited(true);
  }, [props.active]);
  return props.active || visited ? (
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

function CompositionLoading({ onClose }: { onClose: () => void }) {
  const mobile = useMobileWebLayout();
  return (
    <DeferredSurfaceLoading
      title="合成聊天记录"
      presentation={mobile ? 'page' : 'floating'}
      keepMobileNavigation
      onClose={onClose}
    />
  );
}

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
        props.popup ? (
          createPortal(loading, props.popup.document.body)
        ) : props.fallback ? (
          <CompositionLoading onClose={props.onClose} />
        ) : null
      }
    >
      <CompositionContent {...props} />
    </Suspense>
  );
}

type QzoneAlbumDialogProps = ComponentProps<typeof import('./QzoneAlbumDialog').QzoneAlbumDialog>;
const QzoneAlbumContent = lazyPanel<QzoneAlbumDialogProps>(
  () => import('./QzoneAlbumDialog').then((m) => ({ default: m.QzoneAlbumDialog })),
  ({ onClose, embedded, active, presentation = 'page' }) =>
    active === false ? null : embedded ? (
      <PanelLoading startup={false} />
    ) : (
      <Modal
        presentation={presentation}
        title="空间相册"
        onClose={onClose}
        width={1080}
        labelledBy="weq-qzone-album-title"
      >
        <div className="weq-qzone-album">
          <header className="weq-qzone-album-head">
            <span className="weq-qzone-album-title">
              <span className="weq-qzone-album-title-icon" aria-hidden="true">
                <Images size={16} />
              </span>
              <strong id="weq-qzone-album-title">空间相册</strong>
            </span>
            <button type="button" className="weq-compose-x" onClick={onClose} aria-label="关闭">
              <X size={17} />
            </button>
          </header>
          <PanelLoading startup={false} />
        </div>
      </Modal>
    ),
);

export function QzoneAlbumDialog(props: QzoneAlbumDialogProps) {
  return props.open ? <QzoneAlbumContent {...props} /> : null;
}
export const GroupAlbumDialog = lazyPanel<
  ComponentProps<typeof import('./GroupAlbumDialog').GroupAlbumDialog>
>(
  () => import('./GroupAlbumDialog').then((m) => ({ default: m.GroupAlbumDialog })),
  surfaceLoading('群相册', { presentation: 'sidecar' }),
);
export const GroupAlbumFeedDialog = lazyPanel<
  ComponentProps<typeof import('./GroupAlbumFeedDialog').GroupAlbumFeedDialog>
>(
  () => import('./GroupAlbumFeedDialog').then((m) => ({ default: m.GroupAlbumFeedDialog })),
  surfaceLoading('群相册动态', { presentation: 'sidecar' }),
);
export const GroupFileDialog = lazyPanel<
  ComponentProps<typeof import('./GroupFileDialog').GroupFileDialog>
>(
  () => import('./GroupFileDialog').then((m) => ({ default: m.GroupFileDialog })),
  surfaceLoading('群文件', { presentation: 'sidecar' }),
);
function ProfileLoading({
  onClose,
  anchor,
  point,
}: {
  onClose: () => void;
  anchor?: HTMLElement | OverlayAnchor | null;
  point?: { x: number; y: number };
}) {
  const x = point?.x;
  const y = point?.y;
  const pointAnchor = useMemo(
    () => (x === undefined || y === undefined ? null : { element: null, rect: new DOMRect(x, y) }),
    [x, y],
  );
  return (
    <OverlayLayer
      presentation="popover"
      anchor={pointAnchor ?? anchor}
      anchorPlacement={point ? 'side' : undefined}
      onClose={onClose}
    >
      <div className="weq-profile-loading" role="status">
        <LoadingIndicator>正在加载名片…</LoadingIndicator>
      </div>
    </OverlayLayer>
  );
}
export const ContactProfileDialog = lazyPanel<
  ComponentProps<typeof import('../im-template/template/profilePanes').ContactProfileDialog>
>(
  () =>
    import('../im-template/template/profilePanes').then((m) => ({
      default: m.ContactProfileDialog,
    })),
  ({ embedded, onClose }) => (embedded ? <PanelLoading /> : <ProfileLoading onClose={onClose} />),
);
export const GroupProfileDialog = lazyPanel<
  ComponentProps<typeof import('./groupProfile/GroupProfileSurface').GroupProfileSurface>
>(
  () =>
    import('./groupProfile/GroupProfileSurface').then((m) => ({ default: m.GroupProfileSurface })),
  ({ embedded, anchor, onClose }) =>
    embedded ? <PanelLoading /> : <ProfileLoading anchor={anchor} onClose={onClose} />,
);
export const MemberProfileCard = lazyPanel<
  ComponentProps<typeof import('./MemberProfileCard').MemberProfileCard>
>(
  () => import('./MemberProfileCard').then((m) => ({ default: m.MemberProfileCard })),
  ({ anchor, onClose }) => <ProfileLoading point={anchor} onClose={onClose} />,
);
export const ConversationIdentityCard = lazyPanel<
  ComponentProps<typeof import('./ConversationIdentityCard').ConversationIdentityCard>
>(
  () => import('./ConversationIdentityCard').then((m) => ({ default: m.ConversationIdentityCard })),
  ({ anchor, onClose }) => <ProfileLoading anchor={anchor} onClose={onClose} />,
);
export const SpecialConversationPreview = lazyPanel<
  ComponentProps<typeof import('./SpecialConversationPreview').SpecialConversationPreview>
>(
  () =>
    import('./SpecialConversationPreview').then((m) => ({ default: m.SpecialConversationPreview })),
  surfaceLoading('会话预览', { presentation: 'floating', width: 680 }),
);
export const CloneMemberProfileCard = lazyPanel<
  ComponentProps<typeof import('../views/agentlab/CloneMemberProfileCard').CloneMemberProfileCard>
>(
  () =>
    import('../views/agentlab/CloneMemberProfileCard').then((m) => ({
      default: m.CloneMemberProfileCard,
    })),
  ({ anchor, onClose }) => <ProfileLoading point={anchor} onClose={onClose} />,
);
const GroupTodosContent = lazy(() =>
  import('./qq-actions/GroupActions').then((m) => ({ default: m.GroupTodos })),
);
export function GroupTodos(props: ComponentProps<typeof GroupTodosContent>) {
  return (
    <Suspense
      fallback={
        <section className="weq-group-summary weq-group-todos" aria-label="群待办" aria-busy="true">
          <button type="button" disabled>
            <strong>待办</strong>
            <span className="weq-todo-summary" role="status">
              读取中…
            </span>
          </button>
        </section>
      }
    >
      <GroupTodosContent {...props} />
    </Suspense>
  );
}
export const MediaPreview = lazyPanel<ComponentProps<typeof import('./MediaPreview').MediaPreview>>(
  () => import('./MediaPreview').then((m) => ({ default: m.MediaPreview })),
  ({ active, onClose }) => (
    <DeferredSurfaceLoading title="媒体预览" open={active} onClose={onClose} />
  ),
);

const groupLoadingFrames = {
  announcements: ['群公告', 'group-announcements-dialog', 'modal-scrim group-announcements-scrim'],
  essence: ['群精华', 'group-essence-dialog', 'modal-scrim group-essence-scrim'],
  sign: ['群打卡', 'weq-group-sign-page', 'weq-group-sign-layer'],
  leftMembers: [
    '已退群成员',
    'group-info-detail-dialog weq-group-left-members',
    'modal-scrim group-info-detail-scrim weq-group-left-members-layer',
  ],
} as const;

function GroupFeatureLoading({
  feature,
  groupName,
  onClose,
  embedded,
  anchor,
  presentation,
}: {
  feature: keyof typeof groupLoadingFrames;
  groupName: string;
  onClose: () => void;
  embedded?: boolean;
  anchor?: HTMLElement | null;
  presentation?: GroupFeaturePresentation;
}) {
  const [title, frameClass, layerClass] = groupLoadingFrames[feature];
  const content = (
    <section className={frameClass} role={embedded ? 'region' : 'dialog'} aria-label={title}>
      <header>
        <div>
          <strong>{title}</strong>
          <span>{groupName}</span>
        </div>
        <button
          className="icon-button"
          type="button"
          title="关闭"
          aria-label={`关闭${title}`}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <PanelLoading startup={false} />
    </section>
  );
  return feature === 'leftMembers' ? (
    <OverlayLayer presentation="popover" title={title} className={layerClass} onClose={onClose}>
      {content}
    </OverlayLayer>
  ) : (
    <GroupFeatureSurface
      embedded={embedded}
      anchor={anchor}
      presentation={presentation}
      title={title}
      className={layerClass}
      onClose={onClose}
    >
      {content}
    </GroupFeatureSurface>
  );
}

export const GroupSignDialog = lazyPanel<
  ComponentProps<typeof import('./GroupSignDialog').GroupSignDialog>
>(
  () => import('./GroupSignDialog').then((m) => ({ default: m.GroupSignDialog })),
  (props) => <GroupFeatureLoading {...props} feature="sign" />,
);
export const GroupEssenceDialog = lazyPanel<
  ComponentProps<typeof import('./GroupEssenceDialog').GroupEssenceDialog>
>(
  () => import('./GroupEssenceDialog').then((m) => ({ default: m.GroupEssenceDialog })),
  (props) => <GroupFeatureLoading {...props} feature="essence" />,
);
export const GroupLeftMembersDialog = lazyPanel<
  ComponentProps<typeof import('./GroupLeftMembersDialog').GroupLeftMembersDialog>
>(
  () => import('./GroupLeftMembersDialog').then((m) => ({ default: m.GroupLeftMembersDialog })),
  (props) => <GroupFeatureLoading {...props} feature="leftMembers" />,
);
export const AddMessageModal = lazyPanel<
  ComponentProps<typeof import('./compose/AddMessageModal').AddMessageModal>
>(
  () => import('./compose/AddMessageModal').then((m) => ({ default: m.AddMessageModal })),
  surfaceLoading('添加消息', { presentation: 'floating', width: 430 }),
);
export const MergeForwardDialog = lazyPanel<
  ComponentProps<typeof import('./mergeForward/MergeForwardDialog').MergeForwardDialog>
>(
  () =>
    import('./mergeForward/MergeForwardDialog').then((m) => ({ default: m.MergeForwardDialog })),
  surfaceLoading('合并转发'),
);
export const ForwardedConversationsDialog = lazyPanel<
  ComponentProps<typeof import('./mergeForward/MergeForwardTargets').ForwardedConversationsDialog>
>(
  () =>
    import('./mergeForward/MergeForwardTargets').then((m) => ({
      default: m.ForwardedConversationsDialog,
    })),
  surfaceLoading('转发至会话'),
);
export const DeletedMessagesModal = lazyPanel<
  ComponentProps<typeof import('./compose/DeletedMessagesModal').DeletedMessagesModal>
>(
  () => import('./compose/DeletedMessagesModal').then((m) => ({ default: m.DeletedMessagesModal })),
  surfaceLoading('已删除消息', { presentation: 'floating', width: 720 }),
);
export const RecalledMessagesModal = lazyPanel<
  ComponentProps<typeof import('./compose/RecalledMessagesModal').RecalledMessagesModal>
>(
  () =>
    import('./compose/RecalledMessagesModal').then((m) => ({ default: m.RecalledMessagesModal })),
  surfaceLoading('已撤回消息', { presentation: 'floating', width: 720 }),
);
export const GapMessagesModal = lazyPanel<
  ComponentProps<typeof import('./compose/GapMessagesModal').GapMessagesModal>
>(
  () => import('./compose/GapMessagesModal').then((m) => ({ default: m.GapMessagesModal })),
  surfaceLoading('聊天记录', { presentation: 'floating', width: 720 }),
);
export const ChatRecordsModal = lazyPanel<
  ComponentProps<typeof import('./search/ChatRecordsModal').ChatRecordsModal>
>(
  () => import('./search/ChatRecordsModal').then((m) => ({ default: m.ChatRecordsModal })),
  ({ fixed, initialHit, onClose }) => (
    <Modal presentation="floating" width={960} labelledBy="weq-chatrecords-title" onClose={onClose}>
      <div className="weq-chatrecords">
        <ChatRecordsHeader
          conversationName={fixed ? initialHit.name : undefined}
          onClose={onClose}
        />
        <div className="weq-chatrecords-body is-fixed">
          <PanelLoading />
        </div>
      </div>
    </Modal>
  ),
);
export const SequentialForwardDialog = lazyPanel<
  ComponentProps<typeof import('./SequentialForwardDialog').SequentialForwardDialog>
>(
  () => import('./SequentialForwardDialog').then((m) => ({ default: m.SequentialForwardDialog })),
  surfaceLoading('逐条转发'),
);
export const MessageDetails = lazyPanel<
  ComponentProps<typeof import('./MessageDetails').MessageDetails>
>(
  () => import('./MessageDetails').then((m) => ({ default: m.MessageDetails })),
  surfaceLoading('消息详情', { presentation: 'floating', width: 720 }),
);
export const SearchResultsPanel = lazyPanel<
  ComponentProps<typeof import('./search/SearchResultsPanel').SearchResultsPanel>
>(
  () => import('./search/SearchResultsPanel').then((m) => ({ default: m.SearchResultsPanel })),
  'inline',
);
export const ChatHome = lazyPanel<ComponentProps<typeof import('../views/ChatHome').ChatHome>>(
  () => import('../views/ChatHome').then((m) => ({ default: m.ChatHome })),
  'startup',
);
export const GroupCallWindow = lazyPanel<
  ComponentProps<typeof import('./call/GroupCallWindow').GroupCallWindow>
>(
  () => import('./call/GroupCallWindow').then((m) => ({ default: m.GroupCallWindow })),
  () => <DeferredSurfaceLoading title="群通话" presentation="panel" />,
);
export const GroupCallInvite = lazyPanel<
  ComponentProps<typeof import('./call/GroupCallWindow').GroupCallInvite>
>(
  () => import('./call/GroupCallWindow').then((m) => ({ default: m.GroupCallInvite })),
  ({ title, onClose }) => <DeferredSurfaceLoading title={title} onClose={onClose} width={460} />,
);

export const CallWindow = lazyPanel<ComponentProps<typeof import('./CallWindow').CallWindow>>(
  () => import('./CallWindow').then((m) => ({ default: m.CallWindow })),
  () => <DeferredSurfaceLoading title="通话" presentation="panel" />,
);
type OfficialConversationProps = ComponentProps<
  typeof import('./OfficialConversationPane').OfficialConversationPane
>;
const OfficialConversationContent = lazyPanel<OfficialConversationProps>(
  () => import('./OfficialConversationPane').then((m) => ({ default: m.OfficialConversationPane })),
  'inline',
);

export function OfficialConversationPane(props: OfficialConversationProps) {
  return (
    <ConversationRenderBoundary
      resetKey={JSON.stringify([props.user.id, props.conversationId])}
      onBack={props.onBack}
    >
      <OfficialConversationContent {...props} />
    </ConversationRenderBoundary>
  );
}
export const ContactNoticeDialog = lazyPanel<
  ComponentProps<typeof import('./ContactNoticeDialogs').ContactNoticeDialog>
>(
  () => import('./ContactNoticeDialogs').then((m) => ({ default: m.ContactNoticeDialog })),
  'inline',
);
export const GroupNoticeDialog = lazyPanel<
  ComponentProps<typeof import('./ContactNoticeDialogs').GroupNoticeDialog>
>(() => import('./ContactNoticeDialogs').then((m) => ({ default: m.GroupNoticeDialog })), 'inline');
export const GroupAnnouncementsDialog = lazyPanel<
  ComponentProps<typeof import('./GroupAnnouncementsDialog').GroupAnnouncementsDialog>
>(
  () => import('./GroupAnnouncementsDialog').then((m) => ({ default: m.GroupAnnouncementsDialog })),
  (props) => <GroupFeatureLoading {...props} feature="announcements" />,
);
export const ConversationSettingsDialog = lazyPanel<
  ComponentProps<typeof import('./ConversationSettingsDialog').ConversationSettingsDialog>
>(
  () =>
    import('./ConversationSettingsDialog').then((m) => ({ default: m.ConversationSettingsDialog })),
  ({ anchor, title, onClose }) => (
    <Modal
      presentation="anchored"
      anchor={anchor}
      title="会话设置"
      className="weq-conversation-settings-pane"
      onClose={onClose}
    >
      <section className="weq-cvs-dialog">
        <button
          className="weq-cvs-close"
          type="button"
          aria-label="关闭"
          title="关闭"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <header className="weq-cvs-nav">
          <div className="weq-cvs-nav-head">
            <strong>会话设置</strong>
            <span>{title}</span>
          </div>
        </header>
        <div className="weq-cvs-body">
          <PanelLoading startup={false} />
        </div>
      </section>
    </Modal>
  ),
);
export const QQRemarkDialog = lazyPanel<
  ComponentProps<typeof import('./QQRemarkDialog').QQRemarkDialog>
>(
  () => import('./QQRemarkDialog').then((m) => ({ default: m.QQRemarkDialog })),
  surfaceLoading('修改备注', { presentation: 'popover' }),
);
export const GroupMemberKickDialog = lazyPanel<
  ComponentProps<typeof import('./GroupMemberModerationDialogs').GroupMemberKickDialog>
>(
  () =>
    import('./GroupMemberModerationDialogs').then((m) => ({ default: m.GroupMemberKickDialog })),
  ({ onCancel }) => <DeferredSurfaceLoading title="踢出群聊" onClose={onCancel} />,
);
export const GroupMemberRenameDialog = lazyPanel<
  ComponentProps<typeof import('./GroupMemberModerationDialogs').GroupMemberRenameDialog>
>(
  () =>
    import('./GroupMemberModerationDialogs').then((m) => ({ default: m.GroupMemberRenameDialog })),
  ({ onCancel }) => (
    <DeferredSurfaceLoading title="修改群昵称" presentation="popover" onClose={onCancel} />
  ),
);
export const GroupMemberTitleDialog = lazyPanel<
  ComponentProps<typeof import('./GroupMemberModerationDialogs').GroupMemberTitleDialog>
>(
  () =>
    import('./GroupMemberModerationDialogs').then((m) => ({ default: m.GroupMemberTitleDialog })),
  surfaceLoading('编辑专属头衔', { presentation: 'popover' }),
);
export const ConversationOverviewCalendar = lazyPanel<
  ComponentProps<typeof import('./ConversationOverviewCalendar').ConversationOverviewCalendar>
>(
  () =>
    import('./ConversationOverviewCalendar').then((m) => ({
      default: m.ConversationOverviewCalendar,
    })),
  surfaceLoading('会话总日历', { width: 980 }),
);
