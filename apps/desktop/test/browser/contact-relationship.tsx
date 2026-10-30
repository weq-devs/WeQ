import { createRoot } from 'react-dom/client';
import {
  ContactProfileDialog,
  GroupProfileDialog,
} from '../../src/renderer/src/im-template/template/profilePanes';
import { ContactList } from '../../src/renderer/src/im-template/template/conversationLists';
import { SearchResultCard } from '../../src/renderer/src/components/search/SearchResultCard';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { ContactDirectoryContext } from '../../src/renderer/src/lib/conversationDirectory';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { Contact, GroupConversation } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
Object.assign(window, { relationshipQa: { store: useThemeStore } });
const person: Contact = {
  id: 'u_friend',
  identityLabel: 'QQ',
  identityValue: '10001',
  username: 'u_friend',
  displayName: '合成联系人很长的名称用于检查窄屏布局',
  avatarUrl: null,
  createdAt: new Date(0).toISOString(),
  signature: '合成签名',
};
const stranger = { ...person, id: 'u_stranger', identityValue: '10002', displayName: '合成非好友' };
const group: GroupConversation = {
  id: '20001',
  type: 'group',
  updatedAt: new Date(0).toISOString(),
  lastMessage: null,
  otherUser: null,
  members: [],
  group: {
    id: '20001',
    identityLabel: '群号',
    identityValue: '20001',
    name: '合成群',
    avatarUrl: null,
    announcement: null,
    memberCount: 20,
    role: 'owner',
    roleKnown: true,
  },
};
const directory = {
  selfUid: 'u_self',
  selfUin: '10000',
  friends: new Map([['u_friend', { categoryName: '合成分组' }]]),
  friendsComplete: true,
  groups: new Map([
    ['20001', { listed: true, role: 'admin' }],
    ['20002', { listed: false, role: 'owner' }],
  ]),
};

createRoot(document.getElementById('root')!).render(
  <RelationshipDirectoryContext.Provider value={directory}>
    <style>{`
      html,body,#root{height:auto;min-height:100%;margin:0;overflow:auto}
      .relationship-fixture{min-height:100vh;padding:20px;background:var(--weq-chat-bg);color:var(--weq-fg-primary)}
      .relationship-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;max-width:1180px;margin:auto}
      .relationship-grid>section{min-width:0}
      .relationship-list{max-width:380px;margin:20px auto}
      .relationship-list .weq-conversation-directory{height:auto}
      .relationship-list .weq-search-result{max-width:100%}
      @media(max-width:700px){.relationship-grid{grid-template-columns:minmax(0,1fr)}.relationship-fixture{padding:10px}}
    `}</style>
    <main className="relationship-fixture">
      <div className="relationship-grid">
        <section>
          <ContactProfileDialog contact={person} embedded onClose={() => {}} />
        </section>
        <section>
          <ContactProfileDialog contact={stranger} embedded onClose={() => {}} />
        </section>
        <section>
          <GroupProfileDialog conversation={group} embedded onClose={() => {}} />
        </section>
        <section>
          <GroupProfileDialog
            conversation={{
              ...group,
              id: '20002',
              group: { ...group.group, id: '20002', identityValue: '20002' },
            }}
            embedded
            onClose={() => {}}
          />
        </section>
      </div>
      <section className="relationship-list">
        <ContactDirectoryContext.Provider
          value={{ query: '合成', onQuery: () => {}, ids: [person.id, stranger.id] }}
        >
          <ContactList
            contacts={[person]}
            trailingSections={[{ id: 'history:test', name: '历史联系人', items: [stranger] }]}
            activeContactId={person.id}
            onSelect={() => {}}
          />
        </ContactDirectoryContext.Provider>
        <SearchResultCard
          keyword="合成"
          hit={{
            category: 'contact',
            uid: stranger.id,
            uin: stranger.identityValue,
            nick: stranger.displayName,
            remark: '',
            avatarUrl: null,
            isFriend: false,
            hasConversation: true,
            temporary: false,
            aliases: [],
            groups: [],
          }}
        />
      </section>
    </main>
  </RelationshipDirectoryContext.Provider>,
);
