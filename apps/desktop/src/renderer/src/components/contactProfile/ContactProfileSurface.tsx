import { useContext, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useSurfaceEscape } from '../../lib/surfaceEscape';
import { DraftCloseContext, useDraftClose } from '../../lib/draftClose';
import type { Contact } from '../../im-template/template/types';
import type { ContactWorkspaceTab } from '../../lib/profileNavigation';
import { useContactCardSettings, useContactProfile } from '../../hooks/useContactCard';
import { MemberProfileCard } from '../MemberProfileCard';
import { ContactWorkspace } from '../ContactWorkspace';
import { ContactIdentity } from './ContactContent';
import { ContactActions } from './ContactActions';
import { ProfilePageHeader } from './ProfilePageHeader';
import { toPersonalityProfile } from '../../im-template/template/profilePanes';
import { ContactFieldHistoryProvider } from './ContactFieldHistory';
import { GroupSpeechPreviewContext, ProfilePreviewSourceContext } from '../../lib/chatNavigation';
import { usePersonRelationship } from '../../lib/contactRelationship';

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
  const relationship = usePersonRelationship(profile);
  const title = relationship === 'self' ? '我的资料' : '联系人资料';
  const settings = useContactCardSettings();
  const closing = useDraftClose(onClose, null);
  const preview = useContext(GroupSpeechPreviewContext);
  const page = useRef<HTMLElement>(null);
  const previewing = Boolean(previewContent);
  useLayoutEffect(() => {
    const element = page.current;
    if (previewing && element && !element.contains(element.ownerDocument.activeElement))
      element.focus({ preventScroll: true });
  }, [previewing]);
  useSurfaceEscape(
    page,
    previewContent && preview ? preview.close : closing.requestClose,
    true,
    false,
  );
  const person: Contact = { createdAt: '', ...profile };
  return (
    <ProfilePreviewSourceContext.Provider value="contact">
      <DraftCloseContext.Provider value={closing.drafts}>
        <ContactFieldHistoryProvider
          key={JSON.stringify(scope)}
          entity={`friend:${person.uid || (/^u_/.test(person.id) ? person.id : person.identityValue)}`}
        >
          <section
            ref={page}
            tabIndex={-1}
            className={`weq-profile-dialog weq-contact-profile-content weq-contact-profile-v2${previewContent ? ' is-previewing-chat' : ''}`}
            role="region"
            aria-label={title}
          >
            {!previewContent ? (
              <ProfilePageHeader
                title={title}
                conversationSettings={
                  !person.clone && /^u_/.test(person.uid || person.id)
                    ? {
                        kind: 'c2c',
                        conv: person.uid || person.id,
                        title: person.nick || person.displayName,
                        contact: person,
                      }
                    : undefined
                }
                onClose={closing.requestClose}
                layout="split"
                identity={
                  <ContactIdentity
                    person={person}
                    settings={settings}
                    cardBody
                    pendant={settings.ready && settings.visible.pendant}
                  />
                }
                actions={
                  <ContactActions
                    /* 群内操作（本群发言 / 聊天分析）属于「群内资料」分页的上下文操作，
                       页头再放一次会和分页里的操作条重复；快速名片没有分页，才由名片承载。 */
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
            ) : null}
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
        </ContactFieldHistoryProvider>
      </DraftCloseContext.Provider>
    </ProfilePreviewSourceContext.Provider>
  );
}
