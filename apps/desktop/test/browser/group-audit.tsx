import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GroupProfileSurface } from '../../src/renderer/src/components/groupProfile/GroupProfileSurface';
import {
  ContactWorkspaceNavigationContext,
  type GroupWorkspaceTab,
} from '../../src/renderer/src/lib/profileNavigation';
import {
  ChatNavigationContext,
  GroupMessagePreviewContext,
} from '../../src/renderer/src/lib/chatNavigation';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type {
  GroupConversation,
  GroupMember,
} from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/contact-profile.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });

const LONG = {
  description:
    '这是一段很长的群简介，用来观察三行截断是否自然、展开后是否会把下方内容挤走，以及文字能否被选中复制。\n'.repeat(
      6,
    ),
};

const members: GroupMember[] = Array.from({ length: 6 }, (_, index) => ({
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

function conversation(state: string): GroupConversation {
  const empty = state === 'empty';
  return {
    id: '12345',
    type: 'group',
    updatedAt: '',
    otherUser: null,
    members: empty ? [] : members,
    preference: { pinned: false, muted: false, archived: false },
    unreadCount: 0,
    lastMessage: null,
    group: {
      id: '12345',
      name: empty ? '空资料群' : '原来的群名称',
      remark: empty ? null : '我的群备注',
      identityLabel: '群号',
      identityValue: '12345',
      avatarUrl: null,
      announcement: empty ? null : '只在完整资料显示的公告',
      description: empty ? null : LONG.description,
      memberCount: empty ? 0 : 255,
      maxMemberCount: empty ? 0 : 1000,
      role: 'member',
      listed: true,
      membershipKnown: true,
      roleKnown: true,
      createTime: empty ? null : '2021-01-01T00:00:00Z',
      labels: empty ? '' : '同学',
      customLabels: empty ? [] : ['音乐', '拼车'],
      entranceQ: empty ? null : '入群请说明来意',
      addressName: empty ? null : '福建 · 厦门',
    },
  } as GroupConversation;
}

const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function App() {
  const params = new URLSearchParams(location.search);
  const [previewing, setPreviewing] = useState<'none' | 'group'>('none');
  const initial = params.get('state') ?? 'ok';
  (window as unknown as { __groupAuditMode: string }).__groupAuditMode = initial;
  const [state, setState] = useState(initial);
  const [embedded, setEmbedded] = useState(params.get('view') === 'page');
  const [section, setSection] = useState<GroupWorkspaceTab | undefined>();
  const [long, setLong] = useState(false);
  const theme = useThemeStore;
  const card = useRef<HTMLDivElement>(null);

  const base = conversation(state);
  const withLong = long
    ? {
        ...base,
        group: {
          ...base.group,
          name: '原来的群名称'.repeat(8),
          remark: '我的群备注'.repeat(10),
        },
      }
    : base;

  useLayoutEffect(() => {
    requestAnimationFrame(() => {
      Object.assign(window, {
        groupAuditFirstPaint: document.body.innerText.slice(0, 400),
      });
    });
  }, []);

  Object.assign(window, {
    groupAuditQa: {
      setState: (value: string) => {
        (window as unknown as { __groupAuditMode: string }).__groupAuditMode = value;
        setState(value);
      },
      page: (target?: GroupWorkspaceTab) => {
        setSection(target);
        setEmbedded(true);
      },
      card: () => setEmbedded(false),
      long: () => setLong(true),
      section: (target: GroupWorkspaceTab) => setSection(target),
      theme,
    },
  });

  return (
    <QueryClientProvider client={query}>
      <RelationshipDirectoryContext.Provider
        value={{
          friends: new Map([
            ['u_member8', {}],
            ['u_member2', {}],
          ]),
          friendsComplete: true,
          groups: new Map([['12345', { listed: true, role: 'member' }]]),
        }}
      >
        <ChatNavigationContext.Provider value={() => undefined}>
          <GroupMessagePreviewContext.Provider
            value={{
              open: () => setPreviewing('group'),
              close: () => setPreviewing('none'),
              conversationId: previewing === 'group' ? '12345' : null,
              content:
                previewing === 'group' ? (
                  <section aria-label="合成群消息预览">
                    <button type="button" onClick={() => setPreviewing('none')}>
                      返回资料
                    </button>
                    <p>合成群消息</p>
                  </section>
                ) : null,
            }}
          >
            <ContactWorkspaceNavigationContext.Provider
              value={() => {
                setSection(undefined);
                setEmbedded(true);
              }}
            >
              <div
                ref={card}
                style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}
              >
                <GroupProfileSurface
                  conversation={withLong}
                  embedded={embedded}
                  section={section}
                  onOpenChat={() => undefined}
                  onClose={() => setEmbedded(false)}
                />
              </div>
            </ContactWorkspaceNavigationContext.Provider>
          </GroupMessagePreviewContext.Provider>
        </ChatNavigationContext.Provider>
      </RelationshipDirectoryContext.Provider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
