import { createRoot } from 'react-dom/client';
import { ContactList } from '../../src/renderer/src/im-template/template/conversationLists';
import { ContactProfileDialog } from '../../src/renderer/src/im-template/template/profilePanes';
import { MemberProfileCard } from '../../src/renderer/src/components/MemberProfileCard';
import { ContactDirectoryContext } from '../../src/renderer/src/lib/conversationDirectory';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { Contact } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });
const contacts: Contact[] = [
  { id: 'before', displayName: '前一天', birthMonth: 1, birthDay: 19 },
  {
    id: 'range',
    displayName: '缓存水瓶座',
    age: 16,
    extInfo: { constellation: 1, interactMarks: [], privileges: [], interests: [], album: [] },
  },
  { id: 'exact', displayName: '准确生日', birthYear: 2010, birthMonth: 1, birthDay: 20 },
  { id: 'after', displayName: '后一天', birthMonth: 1, birthDay: 21 },
  {
    id: 'cap',
    displayName: '跨年摩羯座',
    age: 16,
    extInfo: { constellation: 12, interactMarks: [], privileges: [], interests: [], album: [] },
  },
].map((row, i) => ({
  username: row.id,
  identityLabel: 'QQ',
  identityValue: String(10001 + i),
  avatarUrl: null,
  createdAt: '',
  isFriend: true,
  nick: row.displayName,
  ...row,
}));
const selected = contacts[1]!;
const profiles = Object.fromEntries(
  contacts.map((contact) => [
    contact.id,
    {
      ...contact,
      uid: contact.id,
      uin: contact.identityValue,
    },
  ]),
);
Object.assign(window, { contactBirthQa: { profiles, store: useThemeStore } });
const member = new URLSearchParams(location.search).has('member');

createRoot(document.getElementById('root')!).render(
  <ContentSelectionProvider>
    <RelationshipDirectoryContext.Provider
      value={{
        selfUid: 'self',
        selfUin: '99999',
        friendsComplete: true,
        friends: new Map(contacts.map((contact) => [contact.id, { categoryName: '我的好友' }])),
        groups: new Map(),
      }}
    >
      <style>{`html,body,#root{min-height:100%;height:auto;margin:0;overflow:auto}.birth-fixture{padding:16px;min-height:100vh;background:var(--weq-chat-bg);color:var(--weq-fg-primary);display:grid;grid-template-columns:280px minmax(0,440px);gap:24px}.birth-fixture>section{min-width:0}.birth-fixture .weq-contact-directory{height:580px}.birth-fixture h2{font-size:16px;margin:12px 0}@media(max-width:700px){.birth-fixture{grid-template-columns:minmax(0,1fr);padding:8px}.birth-fixture .weq-contact-directory{height:480px}}`}</style>
      <main className="birth-fixture">
        <section data-kind="directory">
          <h2>联系人</h2>
          <ContactDirectoryContext.Provider
            value={{ query: '', onQuery: () => {}, ids: contacts.map((contact) => contact.id) }}
          >
            <ContactList contacts={contacts} activeContactId={null} onSelect={() => {}} />
          </ContactDirectoryContext.Provider>
        </section>
        <section data-kind="profile">
          <h2>联系人资料</h2>
          <ContactProfileDialog contact={selected} embedded onClose={() => {}} />
        </section>
        {member ? (
          <MemberProfileCard member={selected} anchor={{ x: 10, y: 10 }} onClose={() => {}} />
        ) : null}
      </main>
    </RelationshipDirectoryContext.Provider>
  </ContentSelectionProvider>,
);
