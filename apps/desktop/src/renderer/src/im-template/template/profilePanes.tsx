// @ts-nocheck
import { Eye, X } from 'lucide-react';
import { FEATURE_ICONS } from '../../lib/featureIcons.shared';
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
import { Avatar } from './primitives';
import type { Contact, ProfileExtInfo } from './types';
import '../../styles/group-profile.css';
import '../../styles/contact-profile.css';
import { usePersonRelationship } from '../../lib/contactRelationship';

/** 学校 + 学历拼成一行（两者都可能单独缺失）。 */
function _educationText(ext?: ProfileExtInfo | null) {
  if (!ext) {
    return null;
  }
  const parts = [ext.school?.trim(), ext.degree?.trim()].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

export { ContactProfilePane, GroupProfilePane } from '../../components/ProfileEmptyPanes';

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
                  <FEATURE_ICONS.messages size={13} aria-hidden />
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
