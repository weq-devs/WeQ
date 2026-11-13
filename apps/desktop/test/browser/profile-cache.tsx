import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContactList } from '../../src/renderer/src/im-template/template/conversationLists';
import { ContactProfileDialog } from '../../src/renderer/src/im-template/template/profilePanes';
import { GroupLabelSources } from '../../src/renderer/src/components/GroupLabelSources';
import { MutualMarkDialog } from '../../src/renderer/src/components/MutualMarkDialog';
import { MemberProfileCard } from '../../src/renderer/src/components/MemberProfileCard';
import { ContactDirectoryContext } from '../../src/renderer/src/lib/conversationDirectory';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { Contact, GroupConversation } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });
const seconds = Date.parse('2026-11-10T16:01:02Z') / 1000;
const ext = {
  occupation: 13,
  bloodType: 5,
  zodiac: 1,
  interactMarks: [{ type: 'fire', markId: 7, iconUrl: 'https://example.test/missing.png' }],
  privileges: [],
  interests: [],
  album: [],
};
const contacts: Contact[] = ['a', 'b', 'c'].map((id, i) => ({
  id,
  identityLabel: 'QQ',
  identityValue: String(10001 + i),
  username: id,
  displayName: `合成联系人${id}`,
  nick: `合成联系人${id}`,
  isFriend: true,
  createdAt: '',
  avatarUrl: null,
  signature: '本地签名，保留原始内容。',
  sigUpdateTime: i === 2 ? undefined : seconds + i,
  extInfo: i === 2 ? null : ext,
}));
const selected = contacts[0]!;
const group = {
  id: '12345',
  name: '合成群',
  customLabelRecords: [
    { content: '同名标签', setterUid: 'a', setTimestamp: String(seconds), labelId: '1' },
    { content: '同名标签', setterUid: 'u_missing', labelId: '2' },
    { content: '长标签'.repeat(30), setterUid: 'u_long'.repeat(15), labelId: '3' },
  ],
} as GroupConversation['group'];
const profiles = Object.fromEntries(
  contacts.map((contact) => [
    contact.id,
    { ...contact, uid: contact.id, uin: contact.identityValue },
  ]),
);
const qa = {
  marks: {
    data: undefined as unknown,
    isLoading: true,
    isSuccess: false,
    error: null as { message: string } | null,
  },
  store: useThemeStore,
  setMarks: (_mode: string) => {},
};
Object.assign(window, { contactBirthQa: { profiles }, profileCacheQa: qa });

function App() {
  const [query, setQuery] = useState('');
  const [, update] = useState(0);
  qa.setMarks = (mode) => {
    qa.marks =
      mode === 'empty'
        ? { data: { categories: [], totalNum: 0 }, isLoading: false, isSuccess: true, error: null }
        : mode === 'error'
          ? {
              data: undefined,
              isLoading: false,
              isSuccess: false,
              error: { message: '离线合成错误' },
            }
          : { data: undefined, isLoading: true, isSuccess: false, error: null };
    update((value) => value + 1);
  };
  return (
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
        <style>{`html,body,#root{height:auto;min-height:100%;margin:0;overflow:auto}.cache-fixture{padding:16px;background:var(--weq-chat-bg);color:var(--weq-fg-primary);display:grid;grid-template-columns:280px minmax(0,480px);gap:24px}.cache-fixture>section{min-width:0}.cache-fixture h2{font-size:16px;margin:12px 0}.cache-fixture .weq-contact-directory{height:480px}.cache-fixture input{max-width:100%;background:var(--background);color:var(--foreground);border:1px solid var(--border)}@media(max-width:700px){.cache-fixture{grid-template-columns:minmax(0,1fr);padding:8px}}`}</style>
        <main className="cache-fixture">
          <section data-kind="directory">
            <h2>联系人</h2>
            <input
              aria-label="搜索联系人"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ContactDirectoryContext.Provider
              value={{ query, onQuery: setQuery, ids: contacts.map((contact) => contact.id) }}
            >
              <ContactList contacts={contacts} activeContactId={null} onSelect={() => {}} />
            </ContactDirectoryContext.Provider>
          </section>
          <section data-kind="profile">
            <h2>联系人资料</h2>
            <ContactProfileDialog contact={selected} embedded onClose={() => {}} />
          </section>
          <section data-kind="labels">
            <h2>群标签</h2>
            <GroupLabelSources
              group={group}
              members={[{ ...selected, role: 'member', joinedAt: '', remark: '本地设置者备注' }]}
            />
          </section>
          <section data-kind="marks">
            <MutualMarkDialog
              uin="10001"
              name={selected.displayName}
              cachedMarks={ext.interactMarks}
              embedded
              onClose={() => {}}
            />
          </section>
          {new URLSearchParams(location.search).has('member') ? (
            <MemberProfileCard member={selected} anchor={{ x: 8, y: 8 }} onClose={() => {}} />
          ) : null}
        </main>
      </RelationshipDirectoryContext.Provider>
    </ContentSelectionProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
