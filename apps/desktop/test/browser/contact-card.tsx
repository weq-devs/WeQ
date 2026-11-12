import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberProfileCard } from '../../src/renderer/src/components/MemberProfileCard';
import { ContactProfileDialog } from '../../src/renderer/src/im-template/template/profilePanes';
import { ContactCardSettings } from '../../src/renderer/src/components/settings/ContactCardSettings';
import {
  ContactWorkspaceNavigationContext,
  type ContactWorkspaceTab,
} from '../../src/renderer/src/lib/profileNavigation';
import { ConversationDirectoryContext } from '../../src/renderer/src/lib/conversationDirectory';
import {
  ChatNavigationContext,
  GroupSpeechPreviewContext,
} from '../../src/renderer/src/lib/chatNavigation';
import { GapMessagesModal } from '../../src/renderer/src/components/compose/GapMessagesModal';
import { sharedGroupConversation } from '../../src/renderer/src/components/ark/groupShareCard';
import { readProfilePreviewPage } from '../../src/renderer/src/lib/profileMessagePreview';
import { QzoneNavigationContext } from '../../src/renderer/src/lib/qzoneNavigation';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { CalendarNavigationContext } from '../../src/renderer/src/lib/calendarNavigation';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { useViewState } from '../../src/renderer/src/state/view';
import type {
  Contact,
  Conversation,
  Message,
} from '../../src/renderer/src/im-template/template/types';
import { fixturePrivileges, qa, useFixture } from './contact-card.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/contact-profile.css';

const sample: Contact = {
  id: 'u_sample',
  uid: 'u_sample',
  identityLabel: 'QQ',
  identityValue: '10002',
  username: 'u_sample',
  displayName: '林同学',
  nick: '林同学',
  remark: '小林',
  avatarUrl: '/resources/qqlevel/penguin.png',
  createdAt: '',
  isFriend: true,
  friendshipKnown: true,
  signature: new URLSearchParams(location.search).has('short-signature')
    ? '认真记录每一天的小事。'
    : '认真记录每一天的小事。\n第二行原文。\n第三行原文。\n第四行原文。',
  sigUpdateTime: 1794390000,
  gender: 2,
  age: 23,
  birthYear: 2003,
  birthMonth: 5,
  birthDay: 12,
  qid: 'sample-person',
  categoryName: '朋友',
  customStatus: '正在听音乐',
  extInfo: {
    interests: ['本地标签'],
    school: '示例大学',
    degree: '本科',
    country: '中国',
    province: '福建',
    city: '厦门',
    privileges: fixturePrivileges,
    interactMarks: [],
    album: [],
  },
  profileContext: {
    groupCode: '10003',
    groupName: '合成群',
    member: {
      card: '群内小林',
      role: 'member',
      customTitle: '',
      memberLevel: 8,
      levelName: '活跃成员',
      joinedAt: '2024-09-01T00:00:00+08:00',
      lastSpeakAt: '2024-09-02T03:04:05+08:00',
    },
  },
};
const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
Object.assign(window, { contactCardQa: qa });
function Fixture() {
  useFixture();
  useEffect(() => {
    useViewState.setState({ openedUin: qa.account });
  }, [qa.account]);
  const [view, setView] = useState('card');
  const [person, setPerson] = useState(sample);
  const [tab, setTab] = useState<ContactWorkspaceTab>('profile');
  const [preview, setPreview] = useState<{
    conversation: Conversation;
    messages: Message[];
    speech: boolean;
  } | null>(null);
  async function openPreview(person: Contact, speech = false) {
    const group = person.profileContext;
    const conversation: Conversation =
      speech && group
        ? {
            ...sharedGroupConversation({
              code: group.groupCode,
              name: group.groupName || '',
              avatar: '',
            }),
            members: [{ ...person, role: 'member', joinedAt: '' }],
          }
        : {
            id: person.id,
            type: 'direct',
            otherUser: person,
            group: null,
            members: [],
            updatedAt: '',
            lastMessage: null,
            unreadCount: 0,
            preference: { pinned: false, muted: false, blocked: false },
          };
    const page = await readProfilePreviewPage({
      kind: speech ? 'group' : 'c2c',
      conv: conversation.id,
      sender: speech ? person.uid || person.id : undefined,
    });
    setPreview({
      conversation,
      speech,
      messages: page.rows.map((row) => ({
        id: row.msgId,
        conversationId: conversation.id,
        senderId: person.id,
        body: 'content' in row ? String(row.content) : '合成私聊消息',
        createdAt: new Date(Number(row.sendTime) * 1000).toISOString(),
      })),
    });
  }
  const previewContent = preview ? (
    <GapMessagesModal
      preview
      embedded
      conversation={preview.conversation}
      user={{ ...sample, id: 'u_self', identityValue: '10001', displayName: '我' }}
      messages={preview.messages}
      title={preview.speech ? '本群发言' : undefined}
      loading={false}
      loadingMore={false}
      error={null}
      hasMore={false}
      moreFailed={false}
      totalCount={preview.messages.length}
      onLoadMore={() => {}}
      onClose={() => setPreview(null)}
    />
  ) : null;
  const target: Contact =
    qa.mode === 'clone'
      ? {
          id: 'virtual:sample',
          clone: true,
          identityLabel: '虚拟',
          identityValue: '',
          username: 'sample',
          displayName: '合成本地好友',
          avatarUrl: null,
          createdAt: '',
        }
      : qa.mode === 'self'
        ? {
            ...person,
            id: 'self:10001',
            uid: 'u_self',
            identityValue: qa.account,
            displayName: '我',
            nick: '我',
            remark: undefined,
          }
        : {
            ...person,
            kind: qa.mode === 'bot' ? 'bot' : 'human',
            isFriend: qa.mode !== 'nonfriend',
            extInfo: person.extInfo
              ? { ...person.extInfo, isEnterprise: qa.mode === 'enterprise' }
              : undefined,
            profileContext: person.profileContext
              ? {
                  ...person.profileContext,
                  member: {
                    ...person.profileContext.member,
                    muteUntil: qa.muted ? '2030-01-01T00:00:00+08:00' : null,
                  },
                }
              : undefined,
          };
  return (
    <QueryClientProvider client={cache}>
      <CalendarNavigationContext.Provider
        value={(target, anchor) => {
          qa.calls.push({ path: 'fixture.navigate', input: { target, anchor } });
        }}
      >
        <DialogHost />
        <RelationshipDirectoryContext.Provider
          value={{
            selfUin: qa.account,
            selfUid: 'u_self',
            friends: new Map(qa.mode === 'friend' ? [[target.id, {}]] : []),
            friendsComplete: true,
            groups: new Map([['10003', { listed: qa.inGroup, role: 'owner' }]]),
          }}
        >
          <ConversationDirectoryContext.Provider
            value={{
              real: [],
              virtual: [],
              onVirtual: () => {},
              onCreate: () => {},
              profileConversationExists: () => !qa.noConversation,
            }}
          >
            <ChatNavigationContext.Provider value={() => {}}>
              <QzoneNavigationContext.Provider value={() => {}}>
                <ContactWorkspaceNavigationContext.Provider
                  value={(target) => {
                    if (target.kind === 'person') {
                      setPerson(target.contact);
                      setTab(target.tab ?? 'profile');
                      setView('page');
                    }
                  }}
                >
                  <style>{`html,body,#root{height:100%;margin:0}.contact-fixture{height:100%;max-width:1120px;margin:auto;background:var(--weq-bg-surface);color:var(--weq-fg-primary);display:flex;flex-direction:column}.fixture-tools{display:flex;gap:12px;padding:8px;flex-shrink:0}.fixture-tools button{border:1px solid var(--weq-border-subtle);border-radius:4px;padding:4px 8px}.fixture-body{min-height:0;flex:1;overflow:auto}`}</style>
                  <GroupSpeechPreviewContext.Provider
                    value={{
                      open: (person) => void openPreview({ createdAt: '', ...person }, true),
                      close: () => setPreview(null),
                    }}
                  >
                    <main className="contact-fixture">
                      <nav className="fixture-tools">
                        <button type="button" onClick={() => setView('card')}>
                          打开名片
                        </button>
                        <button type="button" onClick={() => setView('page')}>
                          资料页
                        </button>
                        <button type="button" onClick={() => setView('settings')}>
                          名片设置
                        </button>
                      </nav>
                      <div className="fixture-body">
                        {view === 'card' ? (
                          <MemberProfileCard
                            member={target}
                            anchor={{ x: 16, y: 58 }}
                            groupCode={target.profileContext?.groupCode}
                            groupName={target.profileContext?.groupName}
                            onClose={() => setView('closed')}
                            onOpenChat={() => {}}
                            onPreviewChat={() => void openPreview(target)}
                            previewContent={previewContent}
                          />
                        ) : view === 'page' ? (
                          <ContactProfileDialog
                            contact={target}
                            embedded
                            tab={tab}
                            onTabChange={setTab}
                            onClose={() => setView('closed')}
                            onPreviewChat={(person) => void openPreview(person)}
                            previewContent={previewContent}
                          />
                        ) : view === 'settings' ? (
                          <ContactCardSettings />
                        ) : null}
                      </div>
                    </main>
                  </GroupSpeechPreviewContext.Provider>
                </ContactWorkspaceNavigationContext.Provider>
              </QzoneNavigationContext.Provider>
            </ChatNavigationContext.Provider>
          </ConversationDirectoryContext.Provider>
        </RelationshipDirectoryContext.Provider>
      </CalendarNavigationContext.Provider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
