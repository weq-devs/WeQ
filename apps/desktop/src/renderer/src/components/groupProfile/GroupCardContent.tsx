import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Pencil } from 'lucide-react';
import type { GroupConversation, GroupMember } from '../../im-template/template/types';
import { Avatar } from '../../im-template/template/primitives';
import { RelationshipDirectoryContext, useGroupRelationship } from '../../lib/contactRelationship';
import type { useGroupProfile } from '../../hooks/useGroupProfile';
import { ContactRow, ContactSection } from '../contactProfile/ContactRow';
import { GroupRelationshipStatus } from '../RelationshipStatus';
import { QQProfileField } from '../QQProfileField';
import { CopyButton } from '../CopyButton';
import { VirtualConversationBadge } from '../VirtualConversationAvatar';
import { openMediaPreview } from '../mediaPreviewStore';
import { GroupFreezeNotice, GroupTags, groupCreationDate } from './GroupContent';
import { GroupCardMemberList } from './GroupCardMemberList';
import { groupJoinedDate } from '../../lib/groupProfileRows';
import { GroupLabelSources } from '../GroupLabelSources';
import { ContactFieldHistoryButton } from '../contactProfile/ContactFieldHistory';
import { useTabActive } from '../RetainedTabs';
import { GroupProfileAvatarEditor } from './GroupProfileAvatarEditor';
import '../../styles/group-quick-card.css';

type ProfileData = ReturnType<typeof useGroupProfile>;

/** 群名片与完整资料页共用身份正文，历史由宿主的 Provider 提供。 */
export function GroupCardIdentity({
  conversation,
  metrics,
  extended,
}: {
  conversation: GroupConversation;
  metrics: ProfileData['metrics'];
  extended?: ProfileData['extended'];
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
  const freeze = extended?.profile?.freezeState;
  const statusMetrics =
    freeze != null && extended?.updatedAt
      ? {
          ...metrics,
          freezeState: {
            value: freeze,
            updatedAt: extended.updatedAt,
            state: 'ready' as const,
            attemptedAt: extended.updatedAt,
          },
        }
      : metrics;
  return (
    <>
      <header className="weq-profile-hero weq-contact-identity weq-group-quick-identity">
        <div className="weq-group-avatar-tools">
          <button
            type="button"
            className="weq-profile-avatar"
            title="查看群头像"
            aria-label="查看群头像"
            disabled={!group.avatarUrl}
            onClick={() => {
              if (group.avatarUrl)
                openMediaPreview({
                  items: [
                    { key: group.avatarUrl, kind: 'image', src: group.avatarUrl, title: name },
                  ],
                });
            }}
          >
            <Avatar name={name} avatarUrl={group.avatarUrl} seed={group.identityValue} />
            {generated ? <VirtualConversationBadge group /> : null}
          </button>
          <ContactFieldHistoryButton label="头像" />
          {editable && (role === 'owner' || role === 'admin') ? (
            <GroupProfileAvatarEditor groupCode={conversation.id} />
          ) : null}
        </div>
        <div className="weq-profile-heading" data-privacy-sensitive>
          <div className="weq-contact-title-line">
            {editable && (role === 'owner' || role === 'admin') ? (
              <div className="weq-profile-name weq-group-quick-name-editor">
                <QQProfileField field="groupName" target={conversation.id} initial={name} inline />
                <CopyButton
                  text={name}
                  className="weq-profile-field-history"
                  title="复制群名"
                  aria-label="复制群名"
                >
                  <Copy size={12} />
                </CopyButton>
                <Pencil size={12} aria-hidden />
              </div>
            ) : (
              <CopyButton
                text={name}
                className="weq-profile-name weq-contact-name"
                title="复制群名"
                aria-label="复制群名"
              >
                {name}
              </CopyButton>
            )}
            <ContactFieldHistoryButton label="群名称" field="groupName" />
          </div>
          {!generated ? <GroupRelationshipStatus group={group} /> : null}
          <div className="weq-group-state-line">
            <GroupFreezeNotice metrics={statusMetrics} />
            <ContactFieldHistoryButton label="冻结状态" />
          </div>
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
  joinedAt,
  ownerUid,
  onOpenMember,
  onOpenMembers,
  full = false,
  memberCountKnown = false,
}: {
  conversation: GroupConversation;
  metrics: ProfileData['metrics'];
  joinedAt?: number | null;
  ownerUid?: string;
  onOpenMember: (member: GroupMember, anchor: { x: number; y: number }) => void;
  onOpenMembers?: () => void;
  full?: boolean;
  memberCountKnown?: boolean;
}) {
  const { group, generated } = conversation;
  const [list, setList] = useState<{ kind: 'members' | 'friends'; anchor: HTMLElement } | null>(
    null,
  );
  const active = useTabActive();
  useEffect(() => {
    if (!active) setList(null);
  }, [active]);
  const friend = metrics?.friendCount;
  const friendCount =
    typeof friend?.value === 'number' &&
    Number.isInteger(friend.value) &&
    friend.value >= 0 &&
    (friend.updatedAt ?? 0) > 0
      ? friend.value
      : null;
  const created = groupCreationDate(group.createTime);
  const joined = !generated ? groupJoinedDate(joinedAt) : null;
  const hasTags = Boolean(
    group.labels?.trim() || group.customLabels?.some((label) => label.trim()),
  );
  const count =
    group.memberCount > 0 || generated || memberCountKnown ? `${group.memberCount} 人` : null;
  return (
    <div className="weq-profile-data weq-contact-sections weq-group-quick-sections">
      {full || group.description?.trim() || hasTags || created || joined ? (
        <ContactSection title={full ? '基本资料' : '群资料'}>
          {full ? (
            <ContactRow label="简介" value={group.description} historyField="description" />
          ) : group.description?.trim() ? (
            <ContactRow label="简介">
              <GroupCardDescription text={group.description} />
            </ContactRow>
          ) : null}
          {full || hasTags ? (
            <ContactRow label="标签" empty={!hasTags}>
              <GroupTags group={group} />
            </ContactRow>
          ) : null}
          <ContactRow label="创建时间" value={created || null} />
          <ContactRow label="我的入群时间" value={joined} />
          {full ? (
            <>
              <ContactRow label="群地点" value={group.addressName} />
              <ContactRow label="入群问题" value={group.entranceQ} />
              <GroupLabelSources group={group} members={conversation.members} />
            </>
          ) : null}
        </ContactSection>
      ) : null}
      <ContactSection title="成员">
        <ContactRow
          label="群容量"
          value={group.maxMemberCount ? `${group.maxMemberCount} 人` : null}
        />
        <ContactRow label="群成员数">
          <button
            type="button"
            className="weq-contact-value"
            aria-label="查看群成员列表"
            title="查看群成员列表"
            onClick={(event) =>
              onOpenMembers
                ? onOpenMembers()
                : setList({ kind: 'members', anchor: event.currentTarget })
            }
          >
            {count || '查看'}
          </button>
        </ContactRow>
        {!generated ? (
          <ContactRow label="群内好友数">
            <button
              type="button"
              className="weq-contact-value"
              aria-label="查看群内好友列表"
              title="查看群内好友列表"
              onClick={(event) => setList({ kind: 'friends', anchor: event.currentTarget })}
            >
              {friendCount === null ? '查看' : `${friendCount} 人`}
            </button>
          </ContactRow>
        ) : null}
      </ContactSection>
      {list ? (
        <GroupCardMemberList
          key={list.kind}
          conversation={conversation}
          ownerUid={ownerUid}
          kind={list.kind}
          anchor={list.anchor}
          onClose={() => setList(null)}
          onOpenMember={onOpenMember}
        />
      ) : null}
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
