import type { ReactNode } from 'react';
import { DraftCloseContext, useDraftClose } from '../../lib/draftClose';
import type { Contact } from '../../im-template/template/types';
import type { ContactWorkspaceTab } from '../../lib/profileNavigation';
import { useContactProfile } from '../../hooks/useContactCard';
import { MemberProfileCard } from '../MemberProfileCard';
import { ContactWorkspace } from '../ContactWorkspace';
import { ContactIdentity } from './ContactContent';
import { ContactActions } from './ContactActions';
import { ProfilePageHeader } from './ProfilePageHeader';
import { toPersonalityProfile } from '../../im-template/template/profilePanes';

export function ContactProfileSurface({
  contact,
  onClose,
  embedded = false,
  tab,
  onTabChange,
  onPreviewChat,
  previewContent,
}: {
  contact: Contact;
  onClose: () => void;
  embedded?: boolean;
  tab?: ContactWorkspaceTab;
  onTabChange?: (tab: ContactWorkspaceTab) => void;
  onPreviewChat?: (contact: Contact) => void;
  previewContent?: ReactNode;
}) {
  if (!embedded)
    return (
      <MemberProfileCard
        member={contact}
        anchor={{
          x: Math.max(10, window.innerWidth / 2 - 180),
          y: Math.max(10, window.innerHeight / 2 - 220),
        }}
        onClose={onClose}
        onPreviewChat={onPreviewChat ? () => onPreviewChat(contact) : undefined}
        previewContent={previewContent}
      />
    );
  return (
    <ContactProfilePage
      key={contact.id}
      {...{ contact, onClose, tab, onTabChange, onPreviewChat, previewContent }}
    />
  );
}
function ContactProfilePage({
  contact,
  onClose,
  tab,
  onTabChange,
  onPreviewChat,
  previewContent,
}: Parameters<typeof ContactProfileSurface>[0]) {
  const { profile, scope } = useContactProfile(contact);
  const closing = useDraftClose(onClose, null);
  const person: Contact = { createdAt: '', ...profile };
  return (
    <DraftCloseContext.Provider value={closing.drafts}>
      <section
        className={`weq-profile-dialog weq-contact-profile-content weq-contact-profile-v2${previewContent ? ' is-previewing-chat' : ''}`}
        role="region"
        aria-label="联系人资料"
      >
        <ProfilePageHeader
          title="联系人资料"
          onClose={closing.requestClose}
          identity={<ContactIdentity person={person} pendant />}
          actions={
            <ContactActions
              hideGroup
              key={JSON.stringify([...scope, person.id, person.identityValue])}
              onNavigate={(action) => {
                void closing.confirmLeave(action);
              }}
              person={person}
              onPreviewChat={onPreviewChat ? () => onPreviewChat(person) : undefined}
            />
          }
        />
        {previewContent ? (
          <div className="weq-contact-chat-preview">{previewContent}</div>
        ) : (
          <ContactWorkspace
            key={JSON.stringify([...scope, person.id, person.profileContext?.groupCode])}
            contact={person}
            tab={tab}
            onTabChange={onTabChange}
            onNavigateAway={onClose}
            personalityProfile={toPersonalityProfile(
              {
                name: person.displayName,
                avatarUrl: person.avatarUrl,
                signature: person.signature,
              },
              person.extInfo,
            )}
          />
        )}
      </section>
    </DraftCloseContext.Provider>
  );
}
