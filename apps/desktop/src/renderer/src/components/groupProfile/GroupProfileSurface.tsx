import { ToolbarLabel } from '../CompactToolbar';
import { observeCompactToolbar } from '../CompactToolbar.shared';
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Eye } from 'lucide-react';
import { FEATURE_ICONS } from '../../lib/featureIcons.shared';
import { ProfileCardBody } from '../ProfileCardBody';
import { ProfileCardControls } from '../ProfileCardControls';
import type { GroupConversation, User, GroupMember } from '../../im-template/template/types';
import { ChatNavigationContext, GroupMessagePreviewContext } from '../../lib/chatNavigation';
import { OverlayLayer } from '../OverlayLayer';
import { MemberProfileCard } from '../MemberProfileCard';
import { useGroupProfile } from '../../hooks/useGroupProfile';
import { GroupWorkspace } from './GroupWorkspace';
import { GroupProfileFeatures } from './GroupProfileFeatures';
import { GroupCardContent, GroupCardIdentity } from './GroupCardContent';
import type { GroupWorkspaceTab } from '../../lib/profileNavigation';
import {
  ContactWorkspaceNavigationContext,
  ProfileNavigationGuardContext,
} from '../../lib/profileNavigation';
import { ContactInlineError } from '../contactProfile/ContactRow';
import { ProfilePageHeader } from '../contactProfile/ProfilePageHeader';
import { ContactFieldHistoryProvider } from '../contactProfile/ContactFieldHistory';
import '../../styles/contact-card.css';
import '../../styles/profile-workspace.css';
import '../../styles/group-card.css';
import '../../styles/contact-workspace.css';
import '../../styles/group-profile.css';
import { DraftCloseContext, useDraftClose } from '../../lib/draftClose';
import { useSurfaceEscape } from '../../lib/surfaceEscape';
import { TabActivity } from '../RetainedTabs';
import type { OverlayAnchor } from '../../lib/overlayAnchor.shared';

export interface GroupProfileSurfaceProps {
  conversation: GroupConversation | undefined;
  anchor?: HTMLElement | OverlayAnchor | null;
  onClose: () => void;
  detailsKnown?: boolean;
  memberCountKnown?: boolean;
  embedded?: boolean;
  details?: ReactNode;
  onOpenMember?: (member: User, anchor: { x: number; y: number }) => void;
  onOpenChat?: () => void;
  section?: GroupWorkspaceTab;
  albumId?: string;
  folderId?: string;
  fileId?: string;
}
export function GroupProfileSurface(props: GroupProfileSurfaceProps) {
  return props.conversation ? (
    <GroupProfileBody key={props.conversation.id} {...props} conversation={props.conversation} />
  ) : null;
}
function GroupProfileBody({
  conversation: initial,
  anchor,
  embedded,
  onClose,
  onOpenChat,
  onOpenMember,
  ...location
}: GroupProfileSurfaceProps & { conversation: GroupConversation }) {
  const data = useGroupProfile(initial, false, Boolean(embedded));
  const { conversation } = data;
  const openChat = useContext(ChatNavigationContext);
  const openWorkspace = useContext(ContactWorkspaceNavigationContext);
  const preview = useContext(GroupMessagePreviewContext);
  const [member, setMember] = useState<{
    scope: string;
    value: GroupMember;
    anchor: { x: number; y: number };
  } | null>(null);
  const previewContent = preview?.conversationId === conversation.id ? preview.content : null;
  const close = () => {
    if (previewContent) preview?.close();
    onClose();
  };
  const closing = useDraftClose(close, null);
  const page = useRef<HTMLElement>(null);
  useSurfaceEscape(
    page,
    previewContent ? () => preview?.close() : closing.requestClose,
    Boolean(embedded),
    false,
    20,
  );
  const register = useContext(ProfileNavigationGuardContext);
  const leave = useRef(closing.confirmLeave);
  leave.current = closing.confirmLeave;
  useEffect(
    () =>
      embedded && register
        ? register((action) => {
            void leave.current(action);
          })
        : undefined,
    [embedded, register],
  );
  const openMember = (value: GroupMember, at: { x: number; y: number }) => {
    if (conversation.generated && onOpenMember) onOpenMember(value, at);
    else setMember({ value, anchor: at, scope: data.scope });
  };
  const canChat = Boolean(onOpenChat || openChat);
  const canPreview = Boolean(preview) && !conversation.generated;
  const canOpenWorkspace = !embedded && Boolean(openWorkspace) && !conversation.generated;
  const openFullProfile = canOpenWorkspace
    ? () => {
        close();
        openWorkspace?.({ kind: 'group', conversation });
      }
    : undefined;
  const chatAction = canChat ? (
    <button
      title={embedded ? '打开会话' : '查看消息'}
      type="button"
      className="weq-contact-secondary"
      onClick={() => {
        if (!embedded) close();
        if (onOpenChat) onOpenChat();
        else openChat?.({ kind: 'group', conversation });
      }}
    >
      <FEATURE_ICONS.messages size={14} aria-hidden />
      <ToolbarLabel>{embedded ? '打开会话' : '查看消息'}</ToolbarLabel>
    </button>
  ) : null;
  const previewAction = canPreview ? (
    <button
      type="button"
      title="预览消息"
      className="weq-contact-secondary"
      onClick={() => preview?.open(conversation)}
    >
      <Eye size={14} aria-hidden />
      <ToolbarLabel>预览消息</ToolbarLabel>
    </button>
  ) : null;
  const pageActions = embedded ? (
    <nav
      ref={observeCompactToolbar}
      className="weq-profile-actions weq-contact-actions weq-profile-card-actions"
      aria-label="群操作"
    >
      {chatAction}
      {previewAction}
    </nav>
  ) : null;
  const content = (
    <>
      <section
        ref={page}
        tabIndex={embedded ? -1 : undefined}
        className={`weq-member-pop weq-contact-card weq-group-card${embedded ? ' weq-group-page' : ' weq-group-quick-card'}${previewContent ? ' is-previewing-chat' : ''}`}
        role={embedded ? 'region' : 'dialog'}
        aria-label="群资料"
      >
        <TabActivity active={!previewContent}>
          <div className="weq-group-page-content" hidden={Boolean(previewContent)}>
            {embedded ? (
              <ProfilePageHeader
                title="群资料"
                conversationSettings={
                  !conversation.generated
                    ? {
                        kind: 'group',
                        conv: conversation.id,
                        title: conversation.group.name,
                        groupConversation: conversation,
                      }
                    : undefined
                }
                closeLabel="关闭群资料"
                onClose={closing.requestClose}
                layout="split"
                identity={
                  <GroupCardIdentity
                    conversation={conversation}
                    metrics={data.metrics}
                    extended={data.extended}
                  />
                }
                actions={pageActions}
              />
            ) : (
              <>
                <ProfileCardControls
                  onExpand={openFullProfile}
                  onClose={closing.requestClose}
                  expandLabel="打开完整群资料"
                  closeLabel="关闭群资料"
                />
                {/* 快速名片同样只让正文滚动，操作条做 footer。 */}
                <ProfileCardBody key={`${data.scope}:${conversation.id}`}>
                  <GroupCardIdentity
                    conversation={conversation}
                    metrics={data.metrics}
                    extended={data.extended}
                  />
                  {data.profileError ? (
                    <ContactInlineError
                      message={data.profileError}
                      retrying={data.profileRefreshing}
                      onRetry={() => void data.retryProfile()}
                    />
                  ) : null}
                  <GroupCardContent
                    key={`${data.scope}:${conversation.id}`}
                    conversation={conversation}
                    metrics={data.metrics}
                    joinedAt={data.joinedAt}
                    ownerUid={data.ownerUid}
                    memberCountKnown={data.memberCountKnown}
                    onOpenMember={openMember}
                  />
                </ProfileCardBody>
              </>
            )}
            {embedded && data.profileError && !previewContent ? (
              <ContactInlineError
                message={data.profileError}
                retrying={data.profileRefreshing}
                onRetry={() => void data.retryProfile()}
              />
            ) : null}
            {embedded && !conversation.generated ? (
              <GroupProfileFeatures conversation={conversation} scope={data.scope} {...location} />
            ) : null}
            {embedded ? (
              <GroupWorkspace
                key={`${data.scope}:${conversation.id}`}
                {...location}
                data={data}
                onOpenMember={openMember}
              />
            ) : null}
            {/* 完整资料页的操作已在页头渲染；这里再来一条会重复操作，并因吸底样式
            压在正文与视口边缘上，所以只在快速名片里保留底部操作行。 */}
            {!embedded && (canChat || canPreview) ? (
              <nav
                ref={observeCompactToolbar}
                className="weq-profile-actions weq-contact-actions weq-profile-card-actions"
                aria-label="群操作"
              >
                {chatAction}
                {previewAction}
              </nav>
            ) : null}
          </div>
        </TabActivity>
        {previewContent ? <div className="weq-contact-chat-preview">{previewContent}</div> : null}
      </section>
      {member && member.scope === data.scope ? (
        <MemberProfileCard
          key={member.value.id}
          member={member.value}
          anchor={member.anchor}
          groupCode={conversation.generated ? undefined : conversation.id}
          groupName={conversation.group.name}
          onClose={() => setMember(null)}
        />
      ) : null}
    </>
  );
  return embedded ? (
    <DraftCloseContext.Provider value={closing.drafts}>
      {conversation.generated ? (
        content
      ) : (
        <ContactFieldHistoryProvider key={data.scope} entity={`group:${conversation.id}`}>
          {content}
        </ContactFieldHistoryProvider>
      )}
    </DraftCloseContext.Provider>
  ) : (
    <OverlayLayer
      profileCard
      anchor={anchor}
      presentation="popover"
      className="weq-profile-layer weq-group-profile-layer"
      title="群资料"
      onClose={closing.requestClose}
    >
      {content}
    </OverlayLayer>
  );
}
