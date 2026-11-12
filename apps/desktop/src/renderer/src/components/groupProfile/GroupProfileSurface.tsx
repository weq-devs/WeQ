import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Eye, MessageSquare, X } from 'lucide-react';
import type { GroupConversation, User, GroupMember } from '../../im-template/template/types';
import { ChatNavigationContext, GroupMessagePreviewContext } from '../../lib/chatNavigation';
import { OverlayLayer } from '../OverlayLayer';
import { MemberProfileCard } from '../MemberProfileCard';
import { useGroupProfile } from '../../hooks/useGroupProfile';
import {
  GroupDescription,
  GroupFacts,
  GroupFreezeNotice,
  GroupIdentity,
  GroupMemberPreview,
  GroupTags,
} from './GroupContent';
import { GroupWorkspace } from './GroupWorkspace';
import type { GroupWorkspaceTab } from '../../lib/profileNavigation';
import {
  ContactWorkspaceNavigationContext,
  ProfileNavigationGuardContext,
} from '../../lib/profileNavigation';
import { ContactInlineError } from '../contactProfile/ContactRow';
import { ProfilePageHeader } from '../contactProfile/ProfilePageHeader';
import '../../styles/contact-card.css';
import '../../styles/profile-workspace.css';
import '../../styles/group-card.css';
import { DraftCloseContext, useDraftClose } from '../../lib/draftClose';

export interface GroupProfileSurfaceProps {
  conversation: GroupConversation | undefined;
  anchor?: HTMLElement | null;
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
  const data = useGroupProfile(initial);
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
  const members = (
    <GroupMemberPreview
      members={data.members}
      loading={data.previewLoading}
      error={data.previewError}
      onRetry={data.retryPreview}
      onOpen={(value, at) => {
        if (conversation.generated && onOpenMember) onOpenMember(value, at);
        else setMember({ value, anchor: at, scope: data.scope });
      }}
    />
  );
  const canChat = Boolean(onOpenChat || openChat);
  const canPreview = Boolean(preview) && !conversation.generated;
  const canOpenWorkspace = !embedded && Boolean(openWorkspace) && !conversation.generated;
  const chatAction = canChat ? (
    <button
      type="button"
      className="weq-profile-perhome weq-contact-primary"
      onClick={() => {
        if (!embedded) close();
        if (onOpenChat) onOpenChat();
        else openChat?.({ kind: 'group', conversation });
      }}
    >
      <MessageSquare size={14} />
      查看消息
    </button>
  ) : null;
  const previewAction = canPreview ? (
    <button
      type="button"
      className="weq-contact-secondary"
      onClick={() => preview?.open(conversation)}
    >
      <Eye size={14} />
      预览消息
    </button>
  ) : null;
  const pageActions =
    embedded && (chatAction || previewAction) ? (
      <nav className="weq-group-card-actions weq-contact-actions" aria-label="群操作">
        {chatAction}
        {previewAction}
      </nav>
    ) : null;
  const content = (
    <>
      <section
        className={`weq-member-pop weq-contact-card weq-group-card${embedded ? ' weq-group-page' : ''}${previewContent ? ' is-previewing-chat' : ''}`}
        role={embedded ? 'region' : 'dialog'}
        aria-label="群资料"
      >
        {embedded ? (
          <ProfilePageHeader
            title="群资料"
            closeLabel="关闭群资料"
            onClose={closing.requestClose}
            identity={<GroupIdentity conversation={conversation} full />}
            actions={pageActions}
          />
        ) : (
          <>
            <button
              className="weq-profile-close"
              type="button"
              title="关闭群资料"
              aria-label="关闭群资料"
              onClick={closing.requestClose}
            >
              <X size={16} />
            </button>
            <GroupIdentity conversation={conversation} onOpen={close} />
          </>
        )}
        {data.profileError ? (
          <ContactInlineError
            message={data.profileError}
            retrying={data.profileRefreshing}
            onRetry={() => void data.retryProfile()}
          />
        ) : null}
        {previewContent ? (
          <div className="weq-contact-chat-preview">{previewContent}</div>
        ) : embedded ? (
          <GroupWorkspace
            key={`${data.scope}:${conversation.id}`}
            {...location}
            conversation={conversation}
            ownerUid={data.ownerUid}
            summary={
              <>
                <GroupDescription text={conversation.group.description} />
                <GroupTags group={conversation.group} />
                <GroupFacts conversation={conversation} metrics={data.metrics} />
                <GroupFreezeNotice metrics={data.metrics} />
              </>
            }
            members={members}
            onOpenMember={(value, at) => setMember({ value, anchor: at, scope: data.scope })}
          />
        ) : (
          <div className="weq-group-card-body">
            <GroupDescription text={conversation.group.description} />
            <GroupTags group={conversation.group} />
            <GroupFacts conversation={conversation} metrics={data.metrics} />
            <GroupFreezeNotice metrics={data.metrics} />
            {members}
          </div>
        )}
        {canChat || canPreview || canOpenWorkspace ? (
          <nav
            className="weq-group-card-actions weq-contact-actions weq-profile-card-actions"
            aria-label="群操作"
          >
            {chatAction}
            {previewAction}
            {canOpenWorkspace ? (
              <button
                type="button"
                className="weq-contact-secondary"
                title="打开完整群资料"
                onClick={() => {
                  close();
                  openWorkspace?.({ kind: 'group', conversation });
                }}
              >
                <ChevronRight size={14} />
                完整群资料
              </button>
            ) : null}
          </nav>
        ) : null}
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
    <DraftCloseContext.Provider value={closing.drafts}>{content}</DraftCloseContext.Provider>
  ) : (
    <OverlayLayer
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
