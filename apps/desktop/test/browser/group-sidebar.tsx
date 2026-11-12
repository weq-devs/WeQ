import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GroupInfoPanel } from '../../src/renderer/src/im-template/template/groupInfoPanel';
import { GroupAnnouncementsDialog } from '../../src/renderer/src/components/GroupAnnouncementsDialog';
import { GroupSignDialog } from '../../src/renderer/src/components/GroupSignDialog';
import { GroupEssenceDialog } from '../../src/renderer/src/components/GroupEssenceDialog';
import { GroupTodos } from '../../src/renderer/src/components/qq-actions/GroupActions';
import { useGroupResourceWindows } from '../../src/renderer/src/hooks/useGroupResourceWindows';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { GroupConversation } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });

const members = Array.from({ length: 300 }, (_, index) => ({
  id: `u_member${index + 1}`,
  username: `u_member${index + 1}`,
  identityLabel: 'QQ',
  identityValue: String(10000 + index + 1),
  uin: String(10000 + index + 1),
  nick: `昵称 ${index + 1}`,
  card: `成员 ${index + 1}`,
  displayName: index === 1 ? '很长的群成员名称用于验证名称与头衔不会挤出侧栏' : `成员 ${index + 1}`,
  avatarUrl: null,
  role: index === 0 ? ('owner' as const) : index === 1 ? ('admin' as const) : ('member' as const),
  joinedAt: '2023-11-15T00:00:00.000Z',
  lastSpeakAt: null,
  muteUntil: null,
  memberLevel: 3,
  levelName: index === 1 ? '非常长的等级名称' : 'Lv3',
  memberFlag: 0,
  customTitle: index === 1 ? '很长的自定义群头衔' : null,
  kind: index === 3 ? 'bot' : 'person',
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
    announcement: '这周的签到改到周六晚上八点，别忘记打卡。'.repeat(12),
    description: '这里是群简介，用来观察侧栏里长文本的换行与截断是否自然。',
    memberCount: 300,
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
    bulletins: [
      {
        fid: 'notice-1',
        publisherUid: 'u_member1',
        textContent: '这周的签到改到周六晚上八点，别忘记打卡。'.repeat(12),
        ctime: '2026-11-13T08:00:00+08:00',
        msgTime: '2026-11-13T08:00:00+08:00',
        text: '这周的签到改到周六晚上八点，别忘记打卡。'.repeat(12),
      },
    ],
  },
} as unknown as GroupConversation;

const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
type Feature = 'announcements' | 'todos' | 'sign' | 'essence';

function App() {
  const [groupCode, setGroupCode] = useState(conversation.id);
  const [ownerKey, setOwnerKey] = useState('99999:fixture');
  const [narrow, setNarrow] = useState(window.innerWidth <= 760);
  const resourceWindows = useGroupResourceWindows({ ownerKey });
  const [feature, setFeature] = useState<{ kind: Feature; anchor: HTMLElement | null } | null>(
    null,
  );
  const [keyword, setKeyword] = useState('');
  const [chatClicks, setChatClicks] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [openedMember, setOpenedMember] = useState('');
  const [memberLoads, setMemberLoads] = useState(0);
  const [jumped, setJumped] = useState<number | null>(null);
  const current = {
    ...conversation,
    id: groupCode,
    group: { ...conversation.group, name: groupCode === '12345' ? '原来的群名称' : '另一个群' },
  };
  const open = (kind: Feature, anchor?: HTMLElement | null) =>
    setFeature((previous) => (previous?.kind === kind ? null : { kind, anchor: anchor ?? null }));
  const close = () => setFeature(null);
  const results = keyword
    ? members.filter((member) =>
        [member.displayName, member.nick, member.uin].some((value) => value.includes(keyword)),
      )
    : [];
  useEffect(() => {
    Object.assign(window, {
      groupSidebarQa: {
        theme: useThemeStore,
        setError,
        setGroup: setGroupCode,
        setOwner: setOwnerKey,
        setMode: (mode: string) => {
          Object.assign(window, { __groupAuditMode: mode });
          void query.invalidateQueries();
        },
      },
    });
    const resize = () => setNarrow(window.innerWidth <= 760);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return (
    <QueryClientProvider client={query}>
      <RelationshipDirectoryContext.Provider
        value={{
          friends: new Map([['u_member2', {}]]),
          friendsComplete: true,
          groups: new Map([['12345', { listed: true, role: 'member' }]]),
        }}
      >
        <style>{`
          html,body,#root{height:100%;margin:0;min-width:0}
          .qa-group-layout{height:100dvh;display:flex;min-width:0;overflow:hidden;background:var(--weq-chat-bg,var(--weq-bg-surface));color:var(--weq-fg-primary);font-family:system-ui}
          .qa-group-chat{display:flex;flex:1;min-width:0;flex-direction:column;justify-content:space-between}
          .qa-chat-header{padding:16px 20px;border-bottom:1px solid var(--weq-border-subtle);font-size:14px}
          .qa-chat-message{margin:24px 20px;font-size:13px}
          .qa-chat-input{margin:20px;display:flex;gap:8px}
          .qa-chat-input input{width:100%;min-width:0;border:1px solid var(--weq-border-strong);background:var(--weq-bg-surface);color:var(--weq-fg-primary);border-radius:6px;padding:8px;font:inherit}
          .qa-chat-input button{flex-shrink:0;border:1px solid var(--weq-border-subtle);border-radius:6px;background:var(--weq-bg-surface);color:var(--weq-fg-primary);padding:8px 12px}
          .qa-group-rail{width:248px;max-width:100%;min-height:0;min-width:0;display:flex;flex-shrink:0}
          .qa-group-rail>.group-info-panel{width:100%;min-width:0}
          @media(max-width:760px){.qa-group-chat{display:none}.qa-group-rail{width:100%}.qa-group-rail>.group-info-panel{display:flex}}
        `}</style>
        <main className="qa-group-layout">
          <section className="qa-group-chat" aria-label="聊天">
            <header className="qa-chat-header">{current.group.name}</header>
            <p className="qa-chat-message">周六晚上八点见。</p>
            <div className="qa-chat-input">
              <input aria-label="消息输入" placeholder="发送消息" />
              <button type="button" onClick={() => setChatClicks((value) => value + 1)}>
                发送
              </button>
            </div>
          </section>
          <div className="qa-group-rail">
            <GroupInfoPanel
              conversation={current}
              layout="sidebar"
              onOpenDetail={() => undefined}
              onOpenMember={(member) => setOpenedMember(member.id)}
              onOpenAnnouncements={(anchor) => open('announcements', anchor)}
              onOpenEssence={(anchor) => open('essence', anchor)}
              onOpenAlbums={() =>
                resourceWindows.open({ kind: 'albums', groupCode, groupName: current.group.name })
              }
              onOpenFiles={() =>
                resourceWindows.open({ kind: 'files', groupCode, groupName: current.group.name })
              }
              onOpenSign={(anchor) => open('sign', anchor)}
              onOpenLeftMembers={() => undefined}
              onAddMember={() => undefined}
              onClose={narrow ? close : undefined}
              activeFeature={feature?.kind}
              onLoadMoreMembers={() => setMemberLoads((value) => value + 1)}
              onRetryMembers={() => setError(null)}
              loadingError={error}
              memberSearch={{
                keyword,
                members: results,
                total: results.length,
                loading: false,
                loadingMore: false,
                hasMore: false,
                error: null,
              }}
              onMemberSearchChange={setKeyword}
              groupTodos={
                <GroupTodos
                  groupId={Number(groupCode)}
                  groupName={current.group.name}
                  embedded
                  popoverOpen={feature?.kind === 'todos'}
                  onPopoverOpenChange={(opened, anchor) =>
                    opened ? open('todos', anchor) : close()
                  }
                  onJumpToMessage={(sequence) => setJumped(Number(sequence))}
                />
              }
            />
          </div>
          <output
            hidden
            data-chat-clicks={chatClicks}
            data-member-loads={memberLoads}
            data-opened-member={openedMember}
            data-jumped={jumped ?? ''}
          />
        </main>
        {resourceWindows.windows}
        {feature?.kind === 'announcements' ? (
          <GroupAnnouncementsDialog
            groupCode={conversation.id}
            groupName={conversation.group.name}
            currentAnnouncement={conversation.group.announcement}
            bulletins={conversation.group.bulletins}
            presentation="popover"
            anchor={feature.anchor}
            onClose={close}
          />
        ) : null}
        {feature?.kind === 'sign' ? (
          <GroupSignDialog
            groupCode={conversation.id}
            groupName={conversation.group.name}
            presentation="popover"
            anchor={feature.anchor}
            onClose={close}
          />
        ) : null}
        {feature?.kind === 'essence' ? (
          <GroupEssenceDialog
            groupCode={conversation.id}
            groupName={conversation.group.name}
            presentation="popover"
            anchor={feature.anchor}
            essenceMessages={[
              {
                id: 'essence-1',
                msgSeq: 815,
                senderName: '成员 1',
                operatorName: '管理员',
                createdAt: '2026-11-13T08:00:00+08:00',
                active: true,
                content: [{ type: 1, text: '周六晚上八点见。' }],
              },
            ]}
            onJumpToMessage={setJumped}
            onClose={close}
          />
        ) : null}
      </RelationshipDirectoryContext.Provider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
