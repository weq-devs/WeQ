// @ts-nocheck
import { Eye, MessageSquare, Waypoints, X } from 'lucide-react';
import { useContext, type ReactNode } from 'react';
import { datalineName, isDatalineUid } from '@weq/codec';
import { deviceAvatarDataUri } from '../../lib/deviceAvatar';
import { OverlayLayer, type OverlayLayerProps } from '../../components/OverlayLayer';
import { ChatNavigationContext } from '../../lib/chatNavigation';
import { ContactProfileSurface } from '../../components/contactProfile/ContactProfileSurface';
import { SelfProfileDisplayProvider } from '../../components/ProfileDisplaySettings';
import { SelfProfileProvider } from '../../components/settings/SelfQQControls';
import { useViewState } from '../../state/view';
import { cn } from './classNames';
import { Avatar, EmptyState } from './primitives';
import type { Contact, ProfileExtInfo } from './types';
import '../../styles/group-profile.css';
import '../../styles/contact-profile.css';
import { usePersonRelationship } from '../../lib/contactRelationship';

export { relationMeta } from '../../lib/profileRelations';
import { zodiac } from '../../lib/contactListOrder';

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

/** 学校 + 学历拼成一行（两者都可能单独缺失）。 */
function _educationText(ext?: ProfileExtInfo | null) {
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

function _ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="weq-contact-section" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function _ProfileIdentity({
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
        {embedded && previewContent ? null : (
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
        )}
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
      <SelfProfileProvider>{content}</SelfProfileProvider>
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

export { GroupProfileSurface as GroupProfileDialog } from '../../components/groupProfile/GroupProfileSurface';

export function genderLabel(value?: number) {
  if (value === 1) {
    return '男';
  }
  if (value === 2) {
    return '女';
  }
  return null;
}
