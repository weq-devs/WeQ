// @ts-nocheck
import {
  Activity,
  Bookmark,
  Cake,
  CalendarDays,
  Check,
  Copy,
  Eye,
  Fingerprint,
  FolderClosed,
  GraduationCap,
  Heart,
  HelpCircle,
  Images,
  Info,
  MapPin,
  MessageSquare,
  Megaphone,
  Sparkles,
  Star,
  Tags,
  User,
  Users,
  Expand,
  Waypoints,
  X,
} from 'lucide-react';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { OverlayLayer, type OverlayLayerProps } from '../../components/OverlayLayer';
import { ChatNavigationContext } from '../../lib/chatNavigation';
import { QzoneNavigationContext } from '../../lib/qzoneNavigation';
import { openLightbox } from '../../components/ImageLightbox';
import { ContactWorkspace } from '../../components/ContactWorkspace';
import { ProfileLikesRow } from '../../components/qq-actions/ProfileLikesRow';
import { CommonRelationships } from '../../components/qq-actions/CommonRelationships';
import {
  ContactWorkspaceNavigationContext,
  type ContactWorkspaceTab,
} from '../../lib/profileNavigation';
import { albumMediaUrl, collectionImageUrl } from '../../lib/resourceUrl';
import { cn } from './classNames';
import { copyTextToClipboard } from './clipboard';
import { formatProfileDate } from './format';
import { Avatar, EmptyState } from './primitives';
import type { Contact, Conversation, ProfileExtInfo } from './types';
import { displayUserName } from './user';
import { relationMeta } from '../../lib/profileRelations';
import '../../styles/group-profile.css';
import '../../styles/contact-profile.css';

export { relationMeta } from '../../lib/profileRelations';

/** 由出生月日推算星座名（标准日期分界）。缺月或日时返回 null。 */
export function constellationOf(month?: number, day?: number) {
  if (!month || !day) {
    return null;
  }
  const table: Array<[cutoff: number, name: string]> = [
    [20, '水瓶座'],
    [19, '双鱼座'],
    [21, '白羊座'],
    [20, '金牛座'],
    [21, '双子座'],
    [22, '巨蟹座'],
    [23, '狮子座'],
    [23, '处女座'],
    [23, '天秤座'],
    [24, '天蝎座'],
    [23, '射手座'],
    [22, '摩羯座'],
  ];
  const idx = month - 1;
  const entry = day < table[idx][0] ? table[(idx + 11) % 12] : table[idx];
  return entry[1];
}

export function birthdayText(year?: number, month?: number, day?: number) {
  if (!month || !day) {
    return null;
  }
  return year && year > 0 ? `${year} 年 ${month} 月 ${day} 日` : `${month} 月 ${day} 日`;
}

/** createdAt 对好友是 epoch（无真实入会时间），>2000 才认为有效。 */
function realCreatedAt(value?: string) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() <= 2000) {
    return null;
  }
  return formatProfileDate(value);
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

/** 学校 + 学历拼成一行（两者都可能单独缺失）。 */
function educationText(ext?: ProfileExtInfo | null) {
  if (!ext) {
    return null;
  }
  const parts = [ext.school?.trim(), ext.degree?.trim()].filter(Boolean);
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
        <button type="button" onClick={overlayProps.onClose}>
          <Waypoints size={15} />
          群交集
        </button>
      </header>
      {children}
    </div>
  );
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="weq-contact-section" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ProfileIdentity({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  return embedded ? <header className="weq-contact-identity">{children}</header> : children;
}

/** 好友资料默认以浮层名片展示，联系人页使用内嵌模式。 */
export function ContactProfileDialog({
  contact,
  onClose,
  embedded = false,
  tab,
  onTabChange,
  onPreviewChat,
  previewContent,
}: {
  contact: Contact | undefined;
  onClose: () => void;
  embedded?: boolean;
  tab?: ContactWorkspaceTab;
  onTabChange?: (tab: ContactWorkspaceTab) => void;
  onPreviewChat?: (contact: Contact) => void;
  previewContent?: ReactNode;
}) {
  const openSpace = useContext(QzoneNavigationContext);
  const openChat = useContext(ChatNavigationContext);
  const openWorkspace = useContext(ContactWorkspaceNavigationContext);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [contact?.id]);

  if (!contact) {
    return null;
  }
  const profile = contact;

  const ext = profile.extRelation;
  const displayId =
    ext?.displayId && ext.displayId > 0 ? ext.displayId : (ext?.preselectedIds?.[0] ?? null);
  const headline = displayId != null ? relationMeta(displayId) : null;
  const tags = ext
    ? (ext.preselectedIds ?? [])
        .filter((id) => id !== displayId)
        .map((id) => ({ id, ...relationMeta(id) }))
    : [];

  const zodiac = constellationOf(profile.birthMonth, profile.birthDay);
  const gender = genderLabel(profile.gender);
  const genderAge = [gender, profile.age ? `${profile.age} 岁` : null].filter(Boolean).join(' · ');
  // 自定义状态优先，没有时退回在线状态文案。
  // 注：天气子结构在 misc.db 侧没有被建模（48902 只解出 customStatus），
  // 所以这里不再尝试拼接「城市 · 天气」。
  const statusText = [profile.customStatus || profile.onlineStatus].filter(Boolean).join(' · ');
  const birthday = birthdayText(profile.birthYear, profile.birthMonth, profile.birthDay);
  const createdAt = realCreatedAt(profile.createdAt);
  const intimacy = profile.intimacy ? Number(profile.intimacy).toLocaleString('en-US') : null;
  const nickDiffers =
    profile.nick && profile.nick !== displayUserName(profile) && profile.nick !== profile.remark;

  // 21000 列扩展资料：已开通的特权（未开通的灰图标没必要展示）、所在地、
  // 教育经历、兴趣标签、精选图片。
  const extInfo = profile.extInfo;
  const openedPrivileges = (extInfo?.privileges ?? []).filter(
    (item) => item.opened && item.iconUrl,
  );
  const region = regionText(extInfo);
  const education = educationText(extInfo);
  const interests = (extInfo?.interests ?? []).filter((tag) => tag.trim());
  const album = extInfo?.album ?? [];

  async function copyIdentity() {
    const ok = await copyTextToClipboard(profile.identityValue);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  const identity = (
    <div className="weq-profile-hero">
      <span className="weq-profile-avatar">
        <Avatar
          name={displayUserName(profile)}
          avatarUrl={profile.avatarUrl}
          seed={profile.identityValue}
        />
      </span>
      <strong className="weq-profile-name">{displayUserName(profile)}</strong>
      {nickDiffers ? <span className="weq-profile-nick">昵称 {profile.nick}</span> : null}
      <button className="weq-profile-id" type="button" onClick={copyIdentity} title="点击复制">
        <span>{profile.identityLabel}</span>
        <span className="weq-number">{profile.identityValue}</span>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>

      {headline || genderAge || zodiac ? (
        <div className="weq-profile-chips">
          {headline ? (
            <span className={cn('weq-profile-rel', headline.intimate && 'is-intimate')}>
              <headline.Icon size={13} strokeWidth={2.2} />
              {headline.intimate ? `密友 · ${headline.label}` : headline.label}
            </span>
          ) : null}
          {genderAge ? <span className="weq-profile-chip">{genderAge}</span> : null}
          {zodiac ? (
            <span className="weq-profile-chip">
              <Sparkles size={12} />
              {zodiac}
            </span>
          ) : null}
        </div>
      ) : null}

      {!embedded && tags.length ? (
        <div className="weq-profile-tags">
          {tags.map((tag) => (
            <span key={tag.id} className="weq-profile-tag">
              <tag.Icon size={12} />
              {tag.label}
            </span>
          ))}
        </div>
      ) : null}

      {!embedded && openedPrivileges.length ? (
        <div className="weq-profile-privileges">
          {openedPrivileges.map((item, index) => (
            <img
              // biome-ignore lint/suspicious/noArrayIndexKey: 同一 bizId 可能出现多条,只有位置是稳定键
              key={`${item.bizId ?? '?'}:${index}`}
              className="weq-profile-privilege"
              src={collectionImageUrl(item.iconUrl as string)}
              alt={privilegeName(item.bizId)}
              title={
                item.level
                  ? `${privilegeName(item.bizId)} · ${item.level} 级`
                  : privilegeName(item.bizId)
              }
              loading="lazy"
            />
          ))}
        </div>
      ) : null}

      {!embedded && profile.signature ? (
        <p className="weq-profile-sign">{profile.signature}</p>
      ) : null}
      {embedded && statusText ? (
        <span
          className="weq-contact-group-summary"
          data-privacy-sensitive={Boolean(profile.customStatus) || undefined}
        >
          {statusText}
        </span>
      ) : null}
    </div>
  );

  const interestSection = interests.length ? (
    <div className="weq-profile-section">
      <div className="weq-profile-section-head">
        <Tags size={13} />
        个性标签
        <span className="weq-number">{interests.length}</span>
      </div>
      <div className="weq-profile-interests">
        {interests.map((tag, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 标签可含零宽字符重复,位置才是稳定键
            key={`${tag}:${index}`}
            className="weq-profile-interest"
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  ) : null;

  const albumSection = album.length ? (
    <div className="weq-profile-section">
      <div className="weq-profile-section-head">
        <Images size={13} />
        精选图片
        <span className="weq-number">{album.length}</span>
      </div>
      <div className="weq-profile-album">
        {album.map((photo, index) => {
          const thumb = albumUrl(photo, [3, 4, 2]);
          const full = albumUrl(photo, [2, 1, 3]);
          if (!thumb) {
            return null;
          }
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: photoId 可能缺失,按位置兜底
              key={`${photo.photoId ?? '?'}:${index}`}
              type="button"
              className="weq-profile-photo"
              title={photo.time ? formatProfileDate(photo.time) : '精选图片'}
              onClick={() => full && openLightbox(albumMediaUrl(full), '精选图片')}
            >
              <img src={albumMediaUrl(thumb)} alt="" loading="lazy" />
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  const personalRows = (
    <>
      <ProfileRow
        sensitive
        icon={<User size={13} />}
        label="用户名"
        value={profile.username}
        mono
      />
      {profile.qid ? (
        <ProfileRow
          sensitive
          icon={<Fingerprint size={13} />}
          label="QID"
          value={profile.qid}
          mono
        />
      ) : null}
      {profile.categoryName ? (
        <ProfileRow
          icon={<FolderClosed size={13} />}
          label="分组"
          sensitive
          value={profile.categoryName}
        />
      ) : null}
      {statusText ? (
        <ProfileRow
          sensitive={Boolean(profile.customStatus)}
          icon={<Activity size={13} />}
          label="状态"
          value={statusText}
        />
      ) : null}
      {region ? (
        <ProfileRow sensitive icon={<MapPin size={13} />} label="所在地" value={region} />
      ) : null}
      {education ? (
        <ProfileRow
          sensitive
          icon={<GraduationCap size={13} />}
          label="教育经历"
          value={education}
        />
      ) : null}
      {birthday ? (
        <ProfileRow sensitive icon={<Cake size={13} />} label="生日" value={birthday} />
      ) : null}
    </>
  );
  const commonRows =
    profile.identityLabel === 'QQ' && profile.kind !== 'bot' ? (
      <CommonRelationships uin={profile.identityValue} />
    ) : null;
  const hasRelationDetails = Boolean(commonRows || intimacy || createdAt);
  const hasSecondary = Boolean(hasRelationDetails || tags.length || openedPrivileges.length);
  const relationRows = (
    <>
      {intimacy ? (
        <ProfileRow icon={<Heart size={13} />} label="亲密度" value={intimacy} mono accent />
      ) : null}
      {profile.kind !== 'bot' && profile.identityLabel === 'QQ' ? (
        <ProfileLikesRow
          uid={profile.id}
          uin={profile.identityValue}
          name={displayUserName(profile)}
        />
      ) : null}
      {createdAt ? (
        <ProfileRow icon={<CalendarDays size={13} />} label="成为好友" value={createdAt} />
      ) : null}
    </>
  );

  const chatAction = openChat ? (
    <div className="weq-profile-actions">
      <button
        className="weq-profile-perhome"
        type="button"
        onClick={() => {
          if (!embedded) onClose();
          openChat({ kind: 'direct', user: profile });
        }}
      >
        <MessageSquare size={13} />
        查看私聊
      </button>
    </div>
  ) : null;
  // 空间保留为导航操作；个性主页与互动功能在联系人页内展示。
  const otherActions =
    profile.identityLabel === 'QQ' && openSpace ? (
      <div className="weq-profile-actions">
        <button
          className="weq-profile-perhome"
          type="button"
          onClick={() => {
            if (!embedded) onClose();
            openSpace(profile.identityValue, profile.nick || displayUserName(profile));
          }}
        >
          <Star size={13} />
          查看空间
        </button>
      </div>
    ) : null;

  return (
    <ProfileSurface
      embedded={embedded}
      title="好友资料"
      className="weq-profile-layer"
      onClose={onClose}
    >
      <section
        className={
          embedded
            ? cn(
                'weq-profile-dialog weq-contact-profile-content',
                previewContent && 'is-previewing-chat',
              )
            : 'weq-profile-dialog weq-anim-pop'
        }
        role={embedded ? 'region' : 'dialog'}
        aria-modal={embedded ? undefined : 'true'}
        aria-label="好友资料"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {embedded ? (
          <>
            <header className="weq-contact-identity">
              {identity}
              <nav className="weq-contact-identity-actions" aria-label="好友操作">
                {chatAction}
                {onPreviewChat ? (
                  <div className="weq-profile-actions">
                    <button
                      className="weq-profile-perhome"
                      type="button"
                      onClick={() => onPreviewChat(profile)}
                    >
                      <Eye size={13} />
                      预览私聊
                    </button>
                  </div>
                ) : null}
                {otherActions}
              </nav>
            </header>
            {previewContent ? (
              <div className="weq-contact-chat-preview">{previewContent}</div>
            ) : (
              <ContactWorkspace
                key={profile.id}
                contact={profile}
                tab={tab}
                onTabChange={onTabChange}
                onNavigateAway={onClose}
                personalityProfile={toPersonalityProfile(
                  {
                    name: displayUserName(profile),
                    avatarUrl: profile.avatarUrl,
                    signature: profile.signature,
                  },
                  extInfo,
                )}
              >
                <div className={cn('weq-contact-columns', !hasSecondary && 'is-single')}>
                  <div className="weq-contact-primary">
                    {profile.signature ? (
                      <ProfileSection title="个性签名">
                        <p className="weq-contact-text" data-privacy-sensitive>
                          {profile.signature}
                        </p>
                      </ProfileSection>
                    ) : null}
                    <ProfileSection title="个人资料">
                      <div className="weq-profile-list">{personalRows}</div>
                    </ProfileSection>
                    {interestSection}
                    {albumSection}
                  </div>
                  {hasSecondary ? (
                    <aside className="weq-contact-secondary">
                      {hasRelationDetails ? (
                        <ProfileSection title="好友关系">
                          <div className="weq-profile-list">
                            {commonRows}
                            {relationRows}
                          </div>
                        </ProfileSection>
                      ) : null}
                      {tags.length ? (
                        <ProfileSection title="关系标识">
                          <div className="weq-profile-tags">
                            {tags.map((tag) => (
                              <span key={tag.id} className="weq-profile-tag">
                                <tag.Icon size={12} />
                                {tag.label}
                              </span>
                            ))}
                          </div>
                        </ProfileSection>
                      ) : null}
                      {openedPrivileges.length ? (
                        <ProfileSection title="已开通特权">
                          <div className="weq-contact-privileges">
                            {openedPrivileges.map((item) => (
                              <span key={`${item.bizId ?? '?'}:${item.iconUrl}:${item.level ?? 0}`}>
                                <img
                                  src={collectionImageUrl(item.iconUrl as string)}
                                  alt=""
                                  loading="lazy"
                                />
                                {privilegeName(item.bizId)}
                                {item.level ? ` · ${item.level} 级` : ''}
                              </span>
                            ))}
                          </div>
                        </ProfileSection>
                      ) : null}
                    </aside>
                  ) : null}
                </div>
              </ContactWorkspace>
            )}
          </>
        ) : (
          <>
            {openWorkspace ? (
              <button
                className="weq-profile-expand"
                type="button"
                title="展开联系人详情"
                aria-label="展开联系人详情"
                onClick={() => {
                  onClose();
                  openWorkspace({ kind: 'person', contact: profile });
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
              onClick={onClose}
            >
              <X size={16} />
            </button>
            {identity}
            {interestSection}
            {albumSection}
            <div className="weq-profile-list">
              {commonRows}
              {personalRows}
              {relationRows}
            </div>
            {chatAction}
            {otherActions}
          </>
        )}
      </section>
    </ProfileSurface>
  );
}

/**
 * 群资料灯箱。结构与好友灯箱一致；「群成员 N 人」下方横向展示若干成员头像
 * （成员由上层从 group_member3 拉取后挂在 conversation.members 上）。
 */
export function GroupProfileDialog({
  conversation,
  onClose,
  detailsKnown = true,
  embedded = false,
  details,
}: {
  conversation: Extract<Conversation, { type: 'group' }> | undefined;
  onClose: () => void;
  detailsKnown?: boolean;
  embedded?: boolean;
  details?: ReactNode;
}) {
  const openChat = useContext(ChatNavigationContext);
  const openWorkspace = useContext(ContactWorkspaceNavigationContext);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [conversation?.id]);

  if (!conversation) {
    return null;
  }
  const group = conversation.group;
  const members = (conversation.members ?? []).slice(0, 14);

  async function copyCode() {
    const ok = await copyTextToClipboard(group.identityValue);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <ProfileSurface
      embedded={embedded}
      title="群资料"
      presentation="popover"
      className="weq-profile-layer weq-group-profile-layer"
      onClose={onClose}
    >
      <section
        className={
          embedded
            ? 'weq-profile-dialog weq-contact-profile-content'
            : 'weq-profile-dialog weq-anim-pop'
        }
        role={embedded ? 'region' : 'dialog'}
        aria-label="群资料"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {!embedded ? (
          <>
            {openWorkspace ? (
              <button
                className="weq-profile-expand"
                type="button"
                title="展开群聊详情"
                aria-label="展开群聊详情"
                onClick={() => {
                  onClose();
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
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </>
        ) : null}

        <ProfileIdentity embedded={embedded}>
          <div className="weq-profile-hero">
            <span className="weq-profile-avatar">
              <Avatar name={group.name} avatarUrl={group.avatarUrl} seed={group.identityValue} />
            </span>
            <strong className="weq-profile-name">{group.name}</strong>
            <button className="weq-profile-id" type="button" onClick={copyCode} title="点击复制">
              <span>群号</span>
              <span className="weq-number">{group.identityValue}</span>
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
            {embedded && detailsKnown ? (
              <span className="weq-contact-group-summary">
                {group.memberCount} 位成员
                {group.roleKnown !== false
                  ? ` · ${group.role === 'owner' ? '群主' : group.role === 'admin' ? '管理员' : '群成员'}`
                  : ''}
              </span>
            ) : null}
          </div>

          {openChat ? (
            <div className="weq-profile-actions">
              <button
                className="weq-profile-perhome"
                type="button"
                onClick={() => {
                  if (!embedded) onClose();
                  openChat({ kind: 'group', conversation });
                }}
              >
                <MessageSquare size={13} />
                查看群聊消息
              </button>
            </div>
          ) : null}
        </ProfileIdentity>
        {embedded && details ? (
          details
        ) : (
          <>
            {detailsKnown ? (
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
                      <span
                        key={member.id}
                        className="weq-profile-member"
                        title={displayUserName(member)}
                      >
                        <Avatar
                          name={displayUserName(member)}
                          avatarUrl={member.avatarUrl}
                          seed={member.identityValue}
                        />
                      </span>
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
