import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GroupInfoPanel } from '../../src/renderer/src/im-template/template/groupInfoPanel';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { GroupConversation } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });

const members = Array.from({ length: 12 }, (_, index) => ({
  id: `u_member${index + 1}`,
  username: `u_member${index + 1}`,
  identityLabel: 'QQ',
  identityValue: String(10000 + index + 1),
  uin: String(10000 + index + 1),
  nick: `昵称 ${index + 1}`,
  card: `成员 ${index + 1}`,
  displayName: `成员 ${index + 1}`,
  avatarUrl: null,
  role: index === 0 ? ('owner' as const) : index === 1 ? ('admin' as const) : ('member' as const),
  joinedAt: '2023-11-15T00:00:00.000Z',
  lastSpeakAt: null,
  muteUntil: null,
  memberLevel: 3,
  levelName: 'Lv3',
  memberFlag: 0,
  customTitle: index === 1 ? '活跃分子' : null,
}));

const conversation = {
  id: '12345',
  type: 'group',
  updatedAt: '',
  otherUser: null,
  members,
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
    announcement: '这周的签到改到周六晚上八点，别忘记打卡。',
    description: '这里是群简介，用来观察侧栏里长文本的换行与截断是否自然。',
    memberCount: 255,
    maxMemberCount: 1000,
    role: 'member',
    listed: true,
    membershipKnown: true,
    roleKnown: true,
    createTime: '2021-01-01T00:00:00Z',
    labels: '同学',
    customLabels: ['音乐', '拼车'],
    entranceQ: '入群请说明来意',
    addressName: '福建 · 厦门',
    bulletins: [{ text: '这周的签到改到周六晚上八点，别忘记打卡。' }],
  },
} as unknown as GroupConversation;

const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function App() {
  const params = new URLSearchParams(location.search);
  const wide = params.get('view') === 'wide';
  return (
    <QueryClientProvider client={query}>
      <RelationshipDirectoryContext.Provider
        value={{
          friends: new Map([['u_member2', {}]]),
          friendsComplete: true,
          groups: new Map([['12345', { listed: true, role: 'member' }]]),
        }}
      >
        <div
          style={{
            height: '100dvh',
            display: 'flex',
            justifyContent: wide ? 'space-between' : 'center',
            alignItems: 'stretch',
            background: 'var(--weq-chat-bg, var(--weq-bg-surface))',
          }}
        >
          <div style={{ width: wide ? 300 : '100%', minHeight: 0, display: 'flex' }}>
            <GroupInfoPanel
              conversation={conversation}
              layout="sidebar"
              onOpenDetail={() => undefined}
              onOpenMember={() => undefined}
              onOpenAnnouncements={() => undefined}
              onOpenEssence={() => undefined}
              onOpenAlbums={() => undefined}
              onOpenFiles={() => undefined}
              onOpenSign={() => undefined}
              onOpenLeftMembers={() => undefined}
              onAddMember={() => undefined}
              onClose={() => undefined}
              onLoadMoreMembers={() => undefined}
              onRetryMembers={() => undefined}
              groupTodos={<p style={{ padding: '8px 0', fontSize: 12 }}>群待办：周五交作业</p>}
            />
          </div>
          {wide ? (
            <div style={{ flex: 1, padding: 24, fontSize: 13, color: 'var(--weq-fg-muted)' }}>
              聊天画布（侧栏对照）
            </div>
          ) : null}
        </div>
      </RelationshipDirectoryContext.Provider>
    </QueryClientProvider>
  );
}

Object.assign(window, {
  groupSidebarQa: { theme: useThemeStore },
});
createRoot(document.getElementById('root')!).render(<App />);
