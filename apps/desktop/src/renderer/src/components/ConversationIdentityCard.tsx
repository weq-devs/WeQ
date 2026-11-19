import { isDatalineUid } from '@weq/codec';
import { Sparkles } from 'lucide-react';
import { Avatar } from '../im-template/template/primitives';
import type { DirectConversation } from '../im-template/template/types';
import { conversationSourceLabel } from '../lib/conversationActions';
import type { VirtualConversation } from '../lib/conversationDirectory';
import type { OverlayAnchor } from '../lib/overlayAnchor.shared';
import { ContactRow } from './contactProfile/ContactRow';
import { OverlayLayer } from './OverlayLayer';
import { ProfileCardControls } from './ProfileCardControls';
import { VirtualConversationAvatar } from './VirtualConversationAvatar';
import '../styles/contact-card.css';

/** 没有 QQ 用户资料接口的会话显示自己的本地身份。 */
export function ConversationIdentityCard({
  conversation,
  virtual,
  anchor,
  onClose,
}: {
  conversation: DirectConversation;
  virtual?: VirtualConversation;
  anchor: OverlayAnchor;
  onClose: () => void;
}) {
  const { otherUser: peer, generated } = conversation;
  const name = peer.displayName || peer.identityValue || conversation.id;
  const source =
    generated?.kind === 'group'
      ? '克隆群聊'
      : (conversationSourceLabel(conversation) ?? '数据线会话');
  const identity = generated?.sessionId || generated?.ownerId || peer.identityValue;
  return (
    <OverlayLayer
      presentation="popover"
      anchor={anchor}
      className="weq-member-pop-scrim"
      onClose={onClose}
    >
      <section className="weq-member-pop weq-contact-card" role="dialog" aria-label="会话资料">
        <ProfileCardControls onClose={onClose} />
        <div className="weq-contact-card-body">
          <div className="weq-profile-hero weq-contact-identity" data-privacy-sensitive>
            <div className="weq-profile-avatar">
              {virtual ? (
                <VirtualConversationAvatar item={virtual} size={64} />
              ) : generated?.kind === 'assistant' ? (
                <span className="avatar has-default merged-avatar" aria-hidden>
                  <Sparkles size={26} />
                </span>
              ) : (
                <Avatar name={name} avatarUrl={peer.avatarUrl} seed={identity} />
              )}
            </div>
            <div className="weq-profile-heading">
              <strong className="weq-profile-name weq-contact-name">{name}</strong>
              <div className="weq-contact-meta">{source}</div>
            </div>
          </div>
          {!isDatalineUid(conversation.id) && peer.identityLabel !== '设备' ? (
            <div className="weq-contact-identity-body weq-profile-data">
              <ContactRow
                label={generated ? 'ID' : peer.identityLabel}
                value={identity}
                copyValue={identity}
                number
              />
            </div>
          ) : null}
        </div>
      </section>
    </OverlayLayer>
  );
}
