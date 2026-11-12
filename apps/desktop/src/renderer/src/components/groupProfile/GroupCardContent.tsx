import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Pencil } from 'lucide-react';
import type { GroupConversation } from '../../im-template/template/types';
import { Avatar } from '../../im-template/template/primitives';
import { RelationshipDirectoryContext, useGroupRelationship } from '../../lib/contactRelationship';
import type { useGroupProfile } from '../../hooks/useGroupProfile';
import { ContactRow, ContactSection } from '../contactProfile/ContactRow';
import { GroupRelationshipStatus } from '../RelationshipStatus';
import { QQProfileField } from '../QQProfileField';
import { VirtualConversationBadge } from '../VirtualConversationAvatar';
import { openMediaPreview } from '../mediaPreviewStore';
import { GroupFreezeNotice, GroupTags, groupCreationDate } from './GroupContent';
import '../../styles/group-quick-card.css';

type ProfileData = ReturnType<typeof useGroupProfile>;

/** 快速名片独立编排，完整资料页继续使用 GroupIdentity / GroupDescription。 */
export function GroupCardIdentity({
  conversation,
  metrics,
  onOpen,
}: {
  conversation: GroupConversation;
  metrics: ProfileData['metrics'];
  onOpen?: () => void;
}) {
  const { group, generated } = conversation;
  const directory = useContext(RelationshipDirectoryContext);
  const relationship = useGroupRelationship(group);
  const role =
    directory?.groups.get(conversation.id)?.role ?? (group.roleKnown ? group.role : null);
  const editable =
    !generated && relationship === 'member' && /^[1-9]\d{0,9}$/.test(conversation.id);
  const name = group.name?.trim() || group.identityValue;
  const identity = generated?.ownerId ?? group.identityValue;
  return (
    <>
      <header className="weq-profile-hero weq-contact-identity weq-group-quick-identity">
        <button
          type="button"
          className="weq-profile-avatar"
          title="查看群头像"
          aria-label="查看群头像"
          disabled={!group.avatarUrl}
          onClick={() => {
            if (group.avatarUrl)
              openMediaPreview({
                items: [{ key: group.avatarUrl, kind: 'image', src: group.avatarUrl, title: name }],
              });
          }}
        >
          <Avatar name={name} avatarUrl={group.avatarUrl} seed={group.identityValue} />
          {generated ? <VirtualConversationBadge group /> : null}
        </button>
        <div className="weq-profile-heading" data-privacy-sensitive>
          {editable && (role === 'owner' || role === 'admin') ? (
            <div className="weq-profile-name weq-group-quick-name-editor">
              <QQProfileField field="groupName" target={conversation.id} initial={name} inline />
              <Pencil size={12} aria-hidden />
            </div>
          ) : (
            <button
              type="button"
              className="weq-profile-name weq-contact-name"
              title={onOpen ? '打开完整群资料' : undefined}
              disabled={!onOpen}
              onClick={(event) => {
                const selection = window.getSelection();
                if (!selection?.toString() || !event.currentTarget.contains(selection.anchorNode))
                  onOpen?.();
              }}
            >
              {name}
            </button>
          )}
          {!generated ? <GroupRelationshipStatus group={group} /> : null}
          <GroupFreezeNotice metrics={metrics} />
        </div>
      </header>
      <div className="weq-contact-identity-body weq-profile-data">
        {editable ? (
          <QQProfileField
            field="groupRemark"
            target={conversation.id}
            initial={group.remark || ''}
            valueClassName="weq-profile-identity-remark"
          />
        ) : (
          <ContactRow
            label="备注"
            value={group.remark}
            valueClassName="weq-profile-identity-remark"
          />
        )}
        <ContactRow
          label={generated ? 'ID' : '群号'}
          value={identity}
          copyValue={identity}
          activateTitle={generated ? '复制 ID' : '复制群号'}
        />
      </div>
    </>
  );
}

export function GroupCardContent({
  conversation,
  metrics,
  members,
  onOpenMembers,
}: {
  conversation: GroupConversation;
  metrics: ProfileData['metrics'];
  members: ReactNode;
  onOpenMembers?: () => void;
}) {
  const { group, generated } = conversation;
  const directory = useContext(RelationshipDirectoryContext);
  const relationship = useGroupRelationship(group);
  const role =
    directory?.groups.get(conversation.id)?.role ?? (group.roleKnown ? group.role : null);
  const friend = metrics?.friendCount;
  const friendCount =
    typeof friend?.value === 'number' &&
    Number.isInteger(friend.value) &&
    friend.value >= 0 &&
    (friend.updatedAt ?? 0) > 0
      ? friend.value
      : null;
  const roleLabel =
    relationship === 'member' && role
      ? { owner: '群主', admin: '管理员', member: '成员' }[role]
      : null;
  const created = groupCreationDate(group.createTime);
  const hasTags = Boolean(
    group.labels?.trim() || group.customLabels?.some((label) => label.trim()),
  );
  const count = group.memberCount > 0 || generated ? `${group.memberCount} 人` : null;
  return (
    <div className="weq-profile-data weq-contact-sections weq-group-quick-sections">
      {group.description?.trim() || hasTags || created ? (
        <ContactSection title="群资料">
          {group.description?.trim() ? (
            <ContactRow label="简介">
              <GroupCardDescription text={group.description} />
            </ContactRow>
          ) : null}
          {hasTags ? (
            <ContactRow label="标签">
              <GroupTags group={group} />
            </ContactRow>
          ) : null}
          <ContactRow label="创建时间" value={created || null} />
        </ContactSection>
      ) : null}
      {roleLabel || friendCount !== null ? (
        <ContactSection title="与我的关系">
          <ContactRow label="我的身份" value={roleLabel} />
          <ContactRow label="群内好友" value={friendCount === null ? null : `${friendCount} 人`} />
        </ContactSection>
      ) : null}
      <ContactSection
        title="成员"
        action={
          onOpenMembers ? (
            <button
              type="button"
              className="weq-profile-section-action"
              aria-label="查看全部群成员"
              onClick={onOpenMembers}
            >
              {count || '查看全部'}
              <ChevronRight size={14} />
            </button>
          ) : count ? (
            <span className="weq-group-count">{count}</span>
          ) : undefined
        }
      >
        {members}
        {group.maxMemberCount ? (
          <ContactRow label="群容量" value={`${group.maxMemberCount} 人`} />
        ) : null}
      </ContactSection>
    </div>
  );
}

function GroupCardDescription({ text }: { text: string }) {
  const content = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setOverflow(element.scrollHeight > lineHeight * 3 + 1);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [text]);
  return (
    <div className="weq-group-description">
      <p ref={content} className={expanded ? undefined : 'is-clamped'}>
        {text}
      </p>
      {overflow ? (
        <button
          type="button"
          className="weq-group-text-action"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起' : '展开'}
        </button>
      ) : null}
    </div>
  );
}
