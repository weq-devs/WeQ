import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GroupProfileSurface } from '../../src/renderer/src/components/groupProfile/GroupProfileSurface';
import { ContactWorkspaceNavigationContext } from '../../src/renderer/src/lib/profileNavigation';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { GroupConversation } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });
const conversation = {
  id: '12345',
  type: 'group',
  updatedAt: '',
  otherUser: null,
  members: [],
  preference: { pinned: false, muted: false, archived: false },
  unreadCount: 0,
  lastMessage: null,
  group: {
    id: '12345',
    name: '原来的群名称',
    remark: '我的群备注',
    identityLabel: '群号',
    identityValue: '12345',
    avatarUrl: null,
    announcement: '只在完整资料显示的公告',
    description: '这是群简介，正文应当能够选择复制。\n'.repeat(12),
    memberCount: 255,
    maxMemberCount: 1000,
    role: 'member',
    listed: true,
    membershipKnown: true,
    roleKnown: true,
    createTime: '2021-01-01T00:00:00Z',
    labels: '同学',
    customLabels: ['音乐'],
  },
} as GroupConversation;
function App() {
  useLayoutEffect(() => {
    requestAnimationFrame(() => {
      Object.assign(window, {
        groupCardFirstPaint: {
          name: document.querySelector('.weq-profile-name')?.textContent,
          hasDescription: Boolean(document.querySelector('.weq-group-description p')),
          avatars: document.querySelectorAll('.weq-group-preview-avatars button').length,
        },
      });
    });
  }, []);
  const [full, setFull] = useState(false);
  const [code, setCode] = useState('12345');
  const [long, setLong] = useState(false);
  const [short, setShort] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [section, setSection] = useState<'members' | undefined>();
  Object.assign(window, {
    groupCardQa: {
      full: () => setFull(true),
      card: () => setFull(false),
      switch: () => setCode('67890'),
      long: () => setLong(true),
      normal: () => {
        setLong(false);
        setShort(false);
        setAdmin(false);
        setEmpty(false);
      },
      short: () => setShort(true),
      admin: () => setAdmin(true),
      empty: () => setEmpty(true),
      theme: useThemeStore,
    },
  });
  return (
    <QueryClientProvider client={query}>
      <RelationshipDirectoryContext.Provider
        value={{
          friends: new Map([['u_member8', {}]]),
          friendsComplete: true,
          groups: new Map([['12345', { listed: true, role: admin ? 'admin' : 'member' }]]),
        }}
      >
        <ContactWorkspaceNavigationContext.Provider
          value={(target) => {
            if (target.kind === 'group')
              setSection(target.section === 'members' ? 'members' : undefined);
            setFull(true);
          }}
        >
          <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
            <GroupProfileSurface
              conversation={{
                ...conversation,
                id: code,
                group: {
                  ...conversation.group,
                  id: code,
                  identityValue: code,
                  ...(short ? { description: '短简介' } : {}),
                  ...(empty
                    ? {
                        description: '',
                        labels: '',
                        customLabels: [],
                        createTime: null,
                        memberCount: 0,
                        maxMemberCount: 0,
                        remark: null,
                      }
                    : {}),
                  ...(long
                    ? { name: '原来的群名称'.repeat(10), remark: '我的群备注'.repeat(12) }
                    : {}),
                },
              }}
              embedded={full}
              section={section}
              onClose={() => setFull(false)}
            />
          </div>
        </ContactWorkspaceNavigationContext.Provider>
      </RelationshipDirectoryContext.Provider>
    </QueryClientProvider>
  );
}
const query = new QueryClient({
  defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
});
createRoot(document.getElementById('root')!).render(<App />);
