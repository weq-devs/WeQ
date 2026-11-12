import { useContext, useState } from 'react';
import { CalendarDays, Check, Copy, RefreshCw, Users } from 'lucide-react';
import type { GroupConversation, GroupMember } from '../../im-template/template/types';
import { Avatar } from '../../im-template/template/primitives';
import { GroupRelationshipStatus } from '../RelationshipStatus';
import { RelationshipDirectoryContext } from '../../lib/contactRelationship';
import { ContactWorkspaceNavigationContext } from '../../lib/profileNavigation';
import { copyTextToClipboard } from '../../im-template/template/clipboard';
import { displayUserName } from '../../im-template/template/user';
import { VirtualConversationBadge } from '../VirtualConversationAvatar';
import type { useGroupProfile } from '../../hooks/useGroupProfile';
import { ContactRow } from '../contactProfile/ContactRow';
import { mergeGroupPreviewMembers } from '../../lib/groupPreviewMembers';

const createdDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function groupCreationDate(value?: string | null) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? createdDate.format(time) : '';
}

/** 群标签：普通标签与自定义标签合并成一行 chip，与联系人名片的标签同一视觉。 */
export function GroupTags({ group }: { group: GroupConversation['group'] }) {
  const labels = [
    ...new Set(
      [...(group.labels ? group.labels.split(/[,，、;；\s]+/) : []), ...(group.customLabels ?? [])]
        .map((label) => label?.trim())
        .filter((label): label is string => Boolean(label)),
    ),
  ];
  if (!labels.length) return null;
  return (
    <div className="weq-group-tags" aria-label="群标签" data-privacy-sensitive>
      {labels.map((label) => (
        <span className="weq-profile-tag" key={label}>
          {label}
        </span>
      ))}
    </div>
  );
}

export function GroupIdentity({
  conversation,
  full = false,
  onOpen,
}: {
  conversation: GroupConversation;
  full?: boolean;
  onOpen?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const open = useContext(ContactWorkspaceNavigationContext);
  const group = conversation.group;
  const name = group.name?.trim() || group.identityValue;
  const enter =
    !full && open && !conversation.generated
      ? () => {
          onOpen?.();
          open({ kind: 'group', conversation });
        }
      : undefined;
  return (
    <header className="weq-group-identity">
      <div className="weq-profile-hero">
        <span className="weq-profile-avatar">
          <Avatar name={name} avatarUrl={group.avatarUrl} seed={group.identityValue} />
          {conversation.generated ? <VirtualConversationBadge group /> : null}
        </span>
        <div className="weq-profile-heading">
          {enter ? (
            <button
              type="button"
              className="weq-profile-name weq-group-name-link"
              title="打开完整群资料"
              aria-label={`打开 ${name} 的完整群资料`}
              onClick={(event) => {
                const selection = window.getSelection();
                if (!selection?.toString() || !event.currentTarget.contains(selection.anchorNode))
                  enter();
              }}
            >
              {name}
            </button>
          ) : (
            <strong className="weq-profile-name">{name}</strong>
          )}
          {/* 快速名片用状态 pill 说明关系；完整资料页把它收进「详细资料」的身份行，
              避免页头和目录之外再多一条状态提示（既有验收要求）。 */}
          {!full && !conversation.generated ? <GroupRelationshipStatus group={group} /> : null}
          <button
            type="button"
            className="weq-profile-id"
            title={copied ? '已复制群号' : '复制群号'}
            onClick={async () => {
              if (await copyTextToClipboard(conversation.generated?.ownerId ?? group.identityValue))
                setCopied(true);
            }}
          >
            <span>{conversation.generated ? 'ID' : '群号'}</span>
            <span className="weq-number">
              {conversation.generated?.ownerId ?? group.identityValue}
            </span>
            {copied ? (
              <>
                <Check size={12} />
                <span>已复制</span>
              </>
            ) : (
              <Copy size={12} />
            )}
          </button>
          {group.memberCount > 0 || conversation.generated ? (
            <span className="weq-group-count">
              <Users size={13} />
              {group.memberCount}
              {group.maxMemberCount ? ` / ${group.maxMemberCount}` : ''} 位成员
            </span>
          ) : null}
        </div>
      </div>
      <ContactRow label="备注" value={group.remark} valueClassName="weq-profile-identity-remark" />
    </header>
  );
}

export function GroupDescription({ text, full = false }: { text?: string | null; full?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!text?.trim()) return null;
  return (
    <section className="weq-group-description" aria-label="群简介">
      <p data-privacy-sensitive className={expanded || full ? undefined : 'is-clamped'}>
        {text}
      </p>
      {!full ? (
        <button
          type="button"
          className="weq-group-text-action"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起' : '展开'}
        </button>
      ) : null}
    </section>
  );
}

/**
 * 名片与概览的事实行：与资料页共用 `ContactRow`，无值不渲染。
 * 只放「查看群资料时最想知道」的少量事实，其余留给资料页。
 */
export function GroupFacts({
  conversation,
  metrics,
}: {
  conversation: GroupConversation;
  metrics?: ReturnType<typeof useGroupProfile>['metrics'];
}) {
  const group = conversation.group;
  const friend = metrics?.friendCount;
  const friendCount =
    typeof friend?.value === 'number' &&
    Number.isInteger(friend.value) &&
    friend.value >= 0 &&
    (friend.updatedAt ?? 0) > 0
      ? friend.value
      : null;
  const created = groupCreationDate(group.createTime);
  return (
    <div className="weq-group-facts">
      <ContactRow label="创建时间" icon={<CalendarDays size={13} />} value={created || null} />
      <ContactRow
        label="群内好友"
        icon={<Users size={13} />}
        value={friendCount === null ? null : `${friendCount} 人`}
      />
    </div>
  );
}

/** 冻结等可信异常状态：一行状态，不占数据行，也不显示「正常」。 */
export function GroupFreezeNotice({
  metrics,
}: {
  metrics?: ReturnType<typeof useGroupProfile>['metrics'];
}) {
  const freeze = metrics?.freezeState;
  const frozen = freeze?.value === 1 && (freeze.updatedAt ?? 0) > 0;
  if (!frozen) return null;
  return (
    <p
      className="weq-group-abnormal"
      role="status"
      title={
        freeze?.updatedAt
          ? `缓存更新于 ${new Date(freeze.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
          : undefined
      }
    >
      {freeze?.state === 'ready' ? '该群已冻结' : '最近记录：该群已冻结'}
    </p>
  );
}

export function GroupMemberPreview({
  members,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  members: GroupMember[];
  loading?: boolean;
  error?: string | null;
  onRetry: () => void;
  onOpen: (member: GroupMember, anchor: { x: number; y: number }) => void;
}) {
  const directory = useContext(RelationshipDirectoryContext);
  const unique = mergeGroupPreviewMembers(
    members.filter(
      (member) => member.memberFlag !== 1 && member.id && member.identityValue !== '0',
    ),
  );
  const friend = (member: GroupMember) =>
    directory?.friends.has(member.id) || directory?.friends.has(member.identityValue) ? 1 : 0;
  const visible = unique.sort((a, b) => friend(b) - friend(a)).slice(0, 8);
  if (!visible.length && !loading && !error) return null;
  return (
    <section className="weq-group-preview" aria-label="成员预览">
      <div className="weq-group-preview-avatars">
        {visible.map((member) => (
          <button
            key={member.id}
            type="button"
            title={displayUserName(member)}
            aria-label={`查看 ${displayUserName(member)} 的资料`}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onOpen(member, { x: rect.right, y: rect.bottom });
            }}
          >
            <Avatar
              name={displayUserName(member)}
              avatarUrl={member.avatarUrl}
              seed={member.identityValue}
            />
          </button>
        ))}
      </div>
      {loading && !visible.length ? (
        <p className="weq-group-preview-state" role="status">
          正在读取成员…
        </p>
      ) : null}
      {error ? (
        <p className="weq-group-preview-state" role="alert">
          <span>{error}</span>
          <button type="button" onClick={onRetry}>
            <RefreshCw size={12} />
            重试
          </button>
        </p>
      ) : null}
    </section>
  );
}
