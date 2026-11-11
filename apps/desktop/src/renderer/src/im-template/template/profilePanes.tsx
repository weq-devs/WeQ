// @ts-nocheck
import {
  Activity,
  Bookmark,
  CalendarDays,
  Check,
  Copy,
  Eye,
  HelpCircle,
  Info,
  MessageSquare,
  Megaphone,
  Users,
  Expand,
  Waypoints,
  X,
} from 'lucide-react';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { datalineName, isDatalineUid } from '@weq/codec';
import { deviceAvatarDataUri } from '../../lib/deviceAvatar';
import { OverlayLayer, type OverlayLayerProps } from '../../components/OverlayLayer';
import { ChatNavigationContext, GroupMessagePreviewContext } from '../../lib/chatNavigation';
import { ContactProfileSurface } from '../../components/contactProfile/ContactProfileSurface';
import { SelfProfileDisplayProvider } from '../../components/ProfileDisplaySettings';
import { useViewState } from '../../state/view';
import { GroupProfileMetrics } from '../../components/GroupProfileMetrics';
import { GroupExtendedProfile } from '../../components/GroupExtendedProfile';
import { ContactWorkspaceNavigationContext } from '../../lib/profileNavigation';
import { cn } from './classNames';
import { copyTextToClipboard } from './clipboard';
import { formatProfileDate } from './format';
import { Avatar, EmptyState } from './primitives';
import type { Contact, Conversation, ProfileExtInfo, User as ProfileUser } from './types';
import { displayUserName } from './user';
import '../../styles/group-profile.css';
import '../../styles/contact-profile.css';
import { VirtualConversationBadge } from '../../components/VirtualConversationAvatar';
import { GroupRelationshipStatus } from '../../components/RelationshipStatus';
import { usePersonRelationship } from '../../lib/contactRelationship';

export { relationMeta } from '../../lib/profileRelations';
import { zodiac } from '../../lib/contactListOrder';
import { useCardDisplayNames } from '../../hooks/useCardDisplayNames';

/** 由出生月日推算星座名（标准日期分界）。缺月或日时返回 null。 */
export function constellationOf(month?: number, day?: number) {
  return zodiac(month, day);
}

export function birthdayText(year?: number, month?: number, day?: number) {
  if (!month || !day) {
    return null;
  }
  return year && year > 0 ? `${year} 年 ${month} 月 ${day} 日` : `${month} 月 ${day} 日`;
}

/**
 * 特权 bizId → 名称。QQ 的特权位很多，这里只标注常见的几个；未知 id 退化成
 * 「特权 N」，图标本身仍然照常渲染（图标 URL 自带等级，视觉上不丢信息）。
 */
const PRIVILEGE_NAMES: Record<number, string> = {
  1: '超级会员',
  102: '黄钻',
  103: '音乐包',
  113: '大会员',
  118: '绿钻',
  119: '情侣特权',
};

function privilegeName(bizId?: number) {
  if (bizId == null) {
    return '特权';
  }
  return PRIVILEGE_NAMES[bizId] ?? `特权 ${bizId}`;
}

/** 国/省/市三级去重拼接（QQ 常只填其中一两级，重复的省市也要合掉）。 */
function regionText(ext?: ProfileExtInfo | null) {
  if (!ext) {
    return null;
  }
  const parts: string[] = [];
  for (const part of [ext.country, ext.province, ext.city]) {
    const value = part?.trim();
    if (value && !parts.includes(value)) {
      parts.push(value);
    }
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * 从一张精选图片的多尺寸变体里挑 URL。档位实测 1=原图 2=640 3=160 4=100，
 * 缩略图优先 160、大图优先 640（原图往往几 MB，点开看也用不着）。
 */
function albumUrl(photo: ProfileExtInfo['album'][number], preferred: number[]): string | null {
  for (const size of preferred) {
    const hit = photo.urls.find((u) => u.size === size && u.url);
    if (hit?.url) {
      return hit.url;
    }
  }
  return photo.urls.find((u) => u.url)?.url ?? null;
}

/**
 * 把资料里的扩展字段（21000 列）翻成个性主页要的形状。
 *
 * 联系人详情复用个性主页内容，只传 `extInfo` 和显示字段，不依赖资料来源。
 */
export function toPersonalityProfile(
  base: { name: string; avatarUrl: string | null; signature?: string | null },
  ext?: ProfileExtInfo | null,
) {
  return {
    ...base,
    isEnterprise: ext?.isEnterprise,
    interests: (ext?.interests ?? []).filter((tag) => tag.trim()),
    privileges: (ext?.privileges ?? [])
      .filter((item) => item.opened && item.iconUrl)
      .map((item) => ({
        bizId: item.bizId,
        level: item.level,
        iconUrl: item.iconUrl,
        label: privilegeName(item.bizId),
      })),
    region: regionText(ext),
    album: (ext?.album ?? [])
      .map((photo) => ({
        thumb: albumUrl(photo, [3, 4, 2]) ?? '',
        full: albumUrl(photo, [2, 1, 3]) ?? '',
      }))
      .filter((p) => p.thumb && p.full),
  };
}

/** 未选择对象时保留占位，群交集由用户主动进入。 */
export function ContactProfilePane({ onOpenOverview }: { onOpenOverview?: () => void }) {
  return (
    <section className={cn('contact-profile-empty weq-contact-reserved')}>
      <EmptyState title="联系人" body="在左侧选择联系人，查看资料卡片。" />
      <ContactOverviewAction onOpen={onOpenOverview} />
    </section>
  );
}

export function GroupProfilePane({ onOpenOverview }: { onOpenOverview?: () => void }) {
  return (
    <section className={cn('contact-profile-empty weq-contact-reserved')}>
      <EmptyState title="群聊" body="在左侧选择群聊，查看群资料。" />
      <ContactOverviewAction onOpen={onOpenOverview} />
    </section>
  );
}

function ContactOverviewAction({ onOpen }: { onOpen?: () => void }) {
  return onOpen ? (
    <button className="weq-profile-perhome" type="button" onClick={onOpen}>
      <Waypoints size={15} />
      群交集
    </button>
  ) : null;
}

/** 联系人页内嵌资料；其他入口保留原有浮层与关闭行为。 */
function ProfileSurface({
  embedded,
  title,
  children,
  ...overlayProps
}: OverlayLayerProps & { embedded: boolean; title: string }) {
  if (!embedded) return <OverlayLayer {...overlayProps}>{children}</OverlayLayer>;
  return (
    <div className="weq-contact-profile">
      <header className="weq-contact-profile-toolbar">
        <strong>{title}</strong>
        <button
          className="weq-settings-close"
          type="button"
          title="关闭资料"
          aria-label="关闭资料"
          onClick={overlayProps.onClose}
        >
          <X size={18} />
        </button>
      </header>
      {children}
    </div>
  );
}

function ProfileIdentity({
  embedded,
  children,
  actions,
  actionsLabel,
}: {
  embedded: boolean;
  children: ReactNode;
  actions: ReactNode;
  actionsLabel: string;
}) {
  return embedded ? (
    <header className="weq-contact-identity">
      {children}
      {actions ? (
        <nav className="weq-contact-identity-actions" aria-label={actionsLabel}>
          {actions}
        </nav>
      ) : null}
    </header>
  ) : (
    <>
      {children}
      {actions}
    </>
  );
}

function DeviceProfile({
  contact,
  embedded,
  onClose,
  onPreviewChat,
  previewContent,
}: {
  contact: Contact;
  embedded: boolean;
  onClose: () => void;
  onPreviewChat?: (contact: Contact) => void;
  previewContent?: ReactNode;
}) {
  const openChat = useContext(ChatNavigationContext);
  const name = datalineName(contact.id) || contact.displayName;
  return (
    <ProfileSurface
      embedded={embedded}
      title="设备信息"
      className="weq-profile-layer"
      onClose={onClose}
    >
      <section
        className={cn(
          'weq-profile-dialog',
          embedded ? 'weq-contact-profile-content' : 'weq-anim-pop',
          previewContent && 'is-previewing-chat',
        )}
        role={embedded ? 'region' : 'dialog'}
        aria-label="设备信息"
        aria-modal={embedded ? undefined : 'true'}
      >
        <header className="weq-contact-identity">
          <div className="weq-profile-hero">
            <span className="weq-profile-avatar">
              <Avatar name={name} avatarUrl={deviceAvatarDataUri(contact.id)} seed={contact.id} />
            </span>
            <div className="weq-profile-heading">
              <strong className="weq-profile-name">{name}</strong>
              <span className="weq-profile-nick">我的设备</span>
            </div>
          </div>
          <nav className="weq-contact-identity-actions" aria-label="设备操作">
            {openChat ? (
              <button
                className="weq-profile-perhome"
                type="button"
                onClick={() => {
                  if (!embedded) onClose();
                  openChat({ kind: 'direct', user: contact });
                }}
              >
                <MessageSquare size={13} />
                查看消息
              </button>
            ) : null}
            {onPreviewChat ? (
              <button
                className="weq-profile-perhome"
                type="button"
                onClick={() => onPreviewChat(contact)}
              >
                <Eye size={13} />
                预览消息
              </button>
            ) : null}
          </nav>
        </header>
        {previewContent ? <div className="weq-contact-chat-preview">{previewContent}</div> : null}
      </section>
    </ProfileSurface>
  );
}

/** 好友资料默认以浮层名片展示，联系人页使用内嵌模式。 */
export function ContactProfileDialog(props: Parameters<typeof ContactProfileDialogBody>[0]) {
  const openedUin = useViewState((state) => state.openedUin);
  const relationship = usePersonRelationship(props.contact ?? {});
  const own =
    props.embedded &&
    relationship === 'self' &&
    !props.contact?.clone &&
    props.contact?.identityLabel === 'QQ' &&
    props.contact.identityValue === openedUin;
  const content = <ContactProfileDialogBody {...props} />;
  return own ? (
    <SelfProfileDisplayProvider key={props.contact.id} uin={props.contact.identityValue}>
      {content}
    </SelfProfileDisplayProvider>
  ) : (
    content
  );
}

function ContactProfileDialogBody(
  props: Omit<Parameters<typeof ContactProfileSurface>[0], 'contact'> & {
    contact: Contact | undefined;
  },
) {
  const { contact, onClose, embedded = false, onPreviewChat, previewContent } = props;
  if (!contact) return null;
  if (contact.identityLabel === '设备' || isDatalineUid(contact.id))
    return (
      <DeviceProfile
        contact={contact}
        embedded={embedded}
        onClose={onClose}
        onPreviewChat={onPreviewChat}
        previewContent={previewContent}
      />
    );
  return <ContactProfileSurface {...props} contact={contact} />;
}

/**
 * 群资料灯箱。结构与好友灯箱一致；「群成员 N 人」下方横向展示若干成员头像
 * （成员由上层从 group_member3 拉取后挂在 conversation.members 上）。
 */
export function GroupProfileDialog({
  conversation,
  anchor,
  onClose,
  detailsKnown = true,
  memberCountKnown = detailsKnown,
  embedded = false,
  details,
  onOpenMember,
  onOpenChat,
}: {
  conversation: Extract<Conversation, { type: 'group' }> | undefined;
  anchor?: HTMLElement | null;
  onClose: () => void;
  detailsKnown?: boolean;
  memberCountKnown?: boolean;
  embedded?: boolean;
  details?: ReactNode;
  onOpenMember?: (member: ProfileUser, anchor: { x: number; y: number }) => void;
  onOpenChat?: () => void;
}) {
  const openChat = useContext(ChatNavigationContext);
  const openWorkspace = useContext(ContactWorkspaceNavigationContext);
  const groupPreview = useContext(GroupMessagePreviewContext);
  const cloudNames = useCardDisplayNames(
    'group',
    conversation?.group.identityValue ?? '',
    Boolean(conversation && !conversation.generated),
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [conversation?.id]);

  if (!conversation) {
    return null;
  }
  const group = cloudNames
    ? { ...conversation.group, name: cloudNames.name || conversation.group.identityValue }
    : conversation.group;
  const members = (conversation.members ?? []).slice(0, 14);
  const MemberIdentity = onOpenMember ? 'button' : 'span';
  const identityValue = conversation.generated?.ownerId ?? group.identityValue;
  const previewContent =
    groupPreview?.conversationId === conversation.id ? groupPreview.content : null;
  const close = () => {
    if (previewContent) groupPreview?.close();
    onClose();
  };

  async function copyCode() {
    const ok = await copyTextToClipboard(identityValue);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <ProfileSurface
      embedded={embedded}
      title="群资料"
      anchor={anchor}
      presentation="popover"
      className="weq-profile-layer weq-group-profile-layer"
      onClose={close}
    >
      <section
        className={cn(
          'weq-profile-dialog',
          embedded ? 'weq-contact-profile-content' : 'weq-anim-pop',
          previewContent && 'is-previewing-chat',
        )}
        role={embedded ? 'region' : 'dialog'}
        aria-label="群资料"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {!embedded ? (
          <>
            {openWorkspace && !conversation.generated ? (
              <button
                className="weq-profile-expand"
                type="button"
                title="展开群聊详情"
                aria-label="展开群聊详情"
                onClick={() => {
                  close();
                  openWorkspace({ kind: 'group', conversation });
                }}
              >
                <Expand size={16} />
              </button>
            ) : null}
            <button
              className="weq-profile-close"
              type="button"
              title="关闭"
              aria-label="关闭"
              onClick={close}
            >
              <X size={16} />
            </button>
          </>
        ) : null}

        <ProfileIdentity
          embedded={embedded}
          actionsLabel="群操作"
          actions={
            onOpenChat || ((openChat || groupPreview) && !conversation.generated) ? (
              <div className="weq-profile-actions">
                {onOpenChat || (openChat && !conversation.generated) ? (
                  <button
                    className="weq-profile-perhome"
                    type="button"
                    onClick={() => {
                      if (previewContent) groupPreview?.close();
                      if (!embedded) onClose();
                      if (onOpenChat) onOpenChat();
                      else openChat?.({ kind: 'group', conversation });
                    }}
                  >
                    <MessageSquare size={13} />
                    查看消息
                  </button>
                ) : null}
                {groupPreview && !conversation.generated ? (
                  <button
                    className="weq-profile-perhome"
                    type="button"
                    onClick={() => groupPreview.open(conversation)}
                  >
                    <Eye size={13} />
                    预览消息
                  </button>
                ) : null}
              </div>
            ) : null
          }
        >
          <div className="weq-profile-hero">
            <span
              className={cn(
                'weq-profile-avatar',
                conversation.generated && 'weq-clone-profile-avatar',
              )}
            >
              <Avatar name={group.name} avatarUrl={group.avatarUrl} seed={group.identityValue} />
              {conversation.generated ? <VirtualConversationBadge group /> : null}
            </span>
            <div className="weq-profile-heading">
              <strong className="weq-profile-name">{group.name}</strong>
              {!embedded && !conversation.generated ? (
                <GroupRelationshipStatus group={group} />
              ) : null}
              <button className="weq-profile-id" type="button" onClick={copyCode} title="点击复制">
                <span>{conversation.generated ? 'ID' : '群号'}</span>
                <span className="weq-number">{identityValue}</span>
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
              {embedded && memberCountKnown ? (
                <span className="weq-contact-group-summary">{group.memberCount} 位成员</span>
              ) : null}
            </div>
          </div>
        </ProfileIdentity>
        {previewContent ? (
          <div className="weq-contact-chat-preview">{previewContent}</div>
        ) : embedded && details ? (
          details
        ) : (
          <>
            {memberCountKnown ? (
              <div className="weq-profile-members">
                <div className="weq-profile-members-head">
                  <Users size={13} />
                  <span>群成员</span>
                  <strong className="weq-number">{group.memberCount}</strong>
                  <span>人</span>
                </div>
                {members.length ? (
                  <div className="weq-profile-members-row">
                    {members.map((member) => (
                      <MemberIdentity
                        type={onOpenMember ? 'button' : undefined}
                        key={member.id}
                        className={cn(
                          'weq-profile-member',
                          onOpenMember && 'weq-group-profile-member-button',
                        )}
                        title={`${displayUserName(member)}${member.clone ? ' · 克隆体' : ''}`}
                        onClick={
                          onOpenMember
                            ? (event) => {
                                const rect = event.currentTarget.getBoundingClientRect();
                                onClose();
                                onOpenMember?.(member, { x: rect.right, y: rect.bottom });
                              }
                            : undefined
                        }
                      >
                        <Avatar
                          name={displayUserName(member)}
                          avatarUrl={member.avatarUrl}
                          seed={member.identityValue}
                        />
                        {member.clone ? <VirtualConversationBadge /> : null}
                      </MemberIdentity>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {detailsKnown ? (
              <div className="weq-profile-list">
                <ProfileRow
                  icon={<Megaphone size={13} />}
                  label="群公告"
                  sensitive
                  value={group.announcement?.trim() || '未设置'}
                  multiline
                />
                {group.description ? (
                  <ProfileRow
                    icon={<Info size={13} />}
                    label="群简介"
                    sensitive
                    value={group.description}
                    multiline
                  />
                ) : null}
                {group.remark ? (
                  <ProfileRow
                    icon={<Bookmark size={13} />}
                    label="群备注"
                    sensitive
                    value={group.remark}
                    multiline
                  />
                ) : null}
                {group.createTime ? (
                  <ProfileRow
                    icon={<CalendarDays size={13} />}
                    label="创建时间"
                    value={formatProfileDate(group.createTime)}
                  />
                ) : null}
                {group.maxMemberCount ? (
                  <ProfileRow
                    icon={<Users size={13} />}
                    label="群容量"
                    value={`${group.memberCount}/${group.maxMemberCount}`}
                    mono
                  />
                ) : null}
                {!conversation.generated ? (
                  <GroupProfileMetrics groupCode={conversation.id}>
                    {(rows) =>
                      rows.map(([label, value], index) => (
                        <ProfileRow
                          key={label}
                          icon={index === 0 ? <Activity size={13} /> : <Users size={13} />}
                          label={label}
                          value={value}
                          mono
                        />
                      ))
                    }
                  </GroupProfileMetrics>
                ) : null}
                {!conversation.generated ? (
                  <GroupExtendedProfile groupCode={conversation.id} />
                ) : null}
                {group.entranceQ ? (
                  <ProfileRow
                    icon={<HelpCircle size={13} />}
                    label="入群问题"
                    sensitive
                    value={group.entranceQ}
                    multiline
                  />
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </section>
    </ProfileSurface>
  );
}

export function ProfileRow({
  icon,
  label,
  value,
  mono,
  accent,
  multiline,
  action,
  sensitive = false,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
  multiline?: boolean;
  /** 行尾追加的操作（例如复制按钮），自动与 value 归为一行右侧。 */
  action?: React.ReactNode;
  sensitive?: boolean;
}) {
  if (multiline) {
    return (
      <div className="weq-profile-row weq-profile-row--block">
        <span className="weq-profile-row-label">
          {icon}
          {label}
        </span>
        <p className="weq-profile-row-text" data-privacy-sensitive={sensitive || undefined}>
          {value}
        </p>
      </div>
    );
  }
  return (
    <div className="weq-profile-row">
      <span className="weq-profile-row-label">
        {icon}
        {label}
      </span>
      {action ? (
        <span className="weq-profile-row-value">
          <strong
            data-privacy-sensitive={sensitive || undefined}
            className={cn(mono && 'weq-number', accent && 'is-accent')}
          >
            {value}
          </strong>
          {action}
        </span>
      ) : (
        <strong
          data-privacy-sensitive={sensitive || undefined}
          className={cn(mono && 'weq-number', accent && 'is-accent')}
        >
          {value}
        </strong>
      )}
    </div>
  );
}

export function genderLabel(value?: number) {
  if (value === 1) {
    return '男';
  }
  if (value === 2) {
    return '女';
  }
  return null;
}
