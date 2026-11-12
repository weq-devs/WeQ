import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import type { Conversation } from '../../src/renderer/src/im-template/template/types';
import {
  ConversationDirectoryContext,
  virtualConversationRow,
  guildConversationRow,
} from '../../src/renderer/src/lib/conversationDirectory';
import {
  assistantConversationRow,
  feedConversationRow,
  generatedAggregateRow,
} from '../../src/renderer/src/lib/conversationDirectoryRows';
import {
  conversationViewRows,
  type ConversationView,
  type ConversationViewDirectory,
} from '../../src/renderer/src/lib/conversationViews';
import {
  ContentSelectionProvider,
  useCurrentContentSelection,
} from '../../src/renderer/src/state/contentSelection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { AssistantConversationPane } from '../../src/renderer/src/views/agentlab/AssistantConversationPane';
import { ConversationBatchExportPane } from '../../src/renderer/src/views/export/ConversationBatchExportPane';
import { conversationBatchSelection } from '../../src/shared/content_selection';
import { useViewState } from '../../src/renderer/src/state/view';
import { groupAssistantPreferences } from '../../src/renderer/src/lib/groupAssistant';
import { createTemplateDemoData } from '../support/templateDemoData';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/rail-navigation.css';
import '../../src/renderer/src/styles/mobile-web.css';
import '../../src/renderer/src/styles/workspace-tools.css';

ensureThemeInitialized();
useViewState.getState().setOpenedUin('10001');
const seed = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
const regular = Array.from(
  { length: 60 },
  (_, index): Conversation => ({
    ...seed,
    id: String(10000 + index),
    group: { ...seed.group, id: String(10000 + index), name: `合成测试群 ${index + 1}` },
    preference: { pinned: false, muted: false, blocked: false },
    updatedAt: new Date(1900000000000 - index * 10000).toISOString(),
    unreadCount: index % 4,
    lastMessage: null,
  }),
);
const clones = [
  {
    id: 'virtual:persona:p1',
    kind: 'persona' as const,
    ownerId: 'p1',
    name: '合成克隆 · 很长的联系人名称用于检查省略与布局',
    updatedAt: 1900000000000,
  },
];
const assistant = assistantConversationRow({
  id: 'assistant-one',
  title: '合成会议整理 · 待办与文档检索',
  updatedAt: 1900000000000,
});
const helper: Conversation = {
  ...generatedAggregateRow('clone', []),
  id: 'merged:group-assistant',
  mergedKind: 'groupAssistant',
  title: '群助手',
  updatedAt: regular[12]!.updatedAt,
};
const directory: ConversationViewDirectory = {
  regular: [
    ...regular,
    helper,
    generatedAggregateRow('clone', clones.map(virtualConversationRow)),
    generatedAggregateRow('assistant', [assistant]),
  ],
  groupAssistant: [
    {
      ...seed,
      id: '20001',
      group: { ...seed.group, id: '20001', name: '助手内测试群' },
      lastMessage: null,
      unreadCount: 7,
      preference: { pinned: false, muted: true, blocked: false },
    },
  ],
  official: [
    feedConversationRow(
      { id: 'official-one', name: '合成公众号', sendTime: '1900000000', prompt: '合成推文' },
      'official',
    ),
  ],
  service: [
    feedConversationRow(
      { id: 'service-one', name: '合成服务号', sendTime: '1900000000', prompt: '合成服务通知' },
      'service',
    ),
  ],
  guild: [
    guildConversationRow({
      nodeId: 'node-one',
      lastTime: '1900000000',
      lastSeq: '1',
      peerTinyId: 'tiny-one',
      peerNick: '合成频道联系人',
      peerAvatarUrl: null,
      preview: null,
    }),
  ],
  hidden: [{ ...regular[0]!, id: 'hidden-one', hidden: true }],
  deleted: [{ ...regular[1]!, id: 'deleted-one', deleted: true }],
  clone: clones.map(virtualConversationRow),
  assistant: [assistant],
};
function SelectionProbe() {
  return (
    <output hidden data-selection>
      {JSON.stringify(useCurrentContentSelection())}
    </output>
  );
}
function Fixture() {
  const [view, setView] = useState<ConversationView>('regular');
  const [back, setBack] = useState(false);
  const [chat, setChat] = useState('原先打开的 QQ 聊天');
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [visited, setVisited] = useState(false);
  const [listShown, setListShown] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const rows = useMemo(
    () => conversationViewRows(directory, view, { includeHidden, includeDeleted }),
    [view, includeHidden, includeDeleted],
  );
  const preferences = view === 'groupAssistant' ? groupAssistantPreferences(rows, {}, {}) : {};
  const onViewChange = (next: ConversationView, aggregate = false) => {
    setBack(aggregate && view === 'regular');
    setView(next);
  };
  useEffect(() => {
    Object.assign(window, {
      conversationViewsQa: {
        store: useThemeStore,
        setView,
        setIncludeHidden,
        setIncludeDeleted,
        chat,
        events,
      },
    });
  }, [chat, events]);
  return (
    <ContentSelectionProvider>
      <ConversationDirectoryContext.Provider
        value={{
          view,
          rows,
          views: directory,
          virtual: clones,
          returnToRegular: back,
          onViewChange,
          onReturnToRegular: () => {
            setBack(false);
            setView('regular');
          },
          onVirtual: (item) => setChat(item.name),
          onCreate: () => setEvents((value) => [...value, 'clone-create']),
          onCreateGroup: () => setEvents((value) => [...value, 'group-create']),
          onCreateAssistant: () => setEvents((value) => [...value, 'assistant-create']),
          onAssistant: (id) => {
            setListShown(false);
            setAssistantId(id);
            setChat(`assistant:${id}`);
            setVisited(true);
          },
          onReadState: () => setEvents((value) => [...value, 'read']),
          onRoaming: (items) => setEvents((value) => [...value, `roaming:${items.length}`]),
          onDelete: async (items) => {
            setEvents((value) => [...value, `delete:${items.length}`]);
          },
          onExportBatch: (items) => setEvents((value) => [...value, `export:${items.length}`]),
          onCalendar: () => setEvents((value) => [...value, `calendar:${view}`]),
        }}
      >
        <style>{`
      html,body,#root{height:100%;margin:0}
      .views-fixture.app-shell{width:100%;min-width:0;height:100%;display:grid;grid-template-columns:320px minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
      .views-fixture .sidebar{grid-column:1;grid-row:1;width:100%;min-width:0}
      .views-fixture .sidebar-body{height:100%;padding:0}
      .views-fixture .weq-conversation-directory{height:100%}
      .views-fixture .fixture-main{grid-column:2;grid-row:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--weq-chat-bg)}
      .fixture-current-chat{padding:20px;color:var(--weq-fg-primary)}
      @media(max-width:720px){.views-fixture.app-shell{grid-template-columns:minmax(0,1fr)}.views-fixture .fixture-main{display:none}.views-fixture.is-assistant .sidebar{display:none}.views-fixture.is-assistant .fixture-main{display:flex;grid-column:1}}
    `}</style>
        <div className="app-shell-root weq-web-shell">
          <div
            className={`views-fixture app-shell${chat.startsWith('assistant:') && !listShown ? ' is-assistant' : ''}`}
          >
            <aside className="sidebar">
              <div className="sidebar-body">
                <ConversationList
                  conversations={rows}
                  activeConversationId={
                    chat.startsWith('assistant:') ? `assistant:${assistantId}` : null
                  }
                  preferences={preferences}
                  drafts={{}}
                  onSelect={setChat}
                />
              </div>
            </aside>
            <main className="fixture-main">
              {visited && (
                <AssistantConversationPane
                  accountScope="synthetic-account"
                  sessionId={assistantId}
                  active={chat.startsWith('assistant:')}
                  onBackToDirectory={() => setListShown(true)}
                  onNewSession={() => setEvents((value) => [...value, 'assistant-create'])}
                />
              )}
              {!chat.startsWith('assistant:') && (
                <div className="fixture-current-chat" data-current-chat>
                  {chat}
                </div>
              )}
            </main>
          </div>
        </div>
        <SelectionProbe />
      </ConversationDirectoryContext.Provider>
    </ContentSelectionProvider>
  );
}
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('export') ? (
    <>
      <style>{`html,body,#root{height:100%;margin:0}#root>.weq-conversation-batch-export{height:100%;max-width:1100px;margin:0 auto;overflow:auto;background:var(--weq-bg-surface)}`}</style>
      <ConversationBatchExportPane
        initialSelection={conversationBatchSelection([
          { id: 'u_peer', ownerId: 'u_peer', kind: 'c2c', name: '合成 QQ 联系人' },
          { id: '10001', ownerId: '10001', kind: 'group', name: '合成 QQ 群聊' },
          { id: 'u_official', ownerId: 'u_official', kind: 'official', name: '合成公众号' },
          { id: 'service:1000', ownerId: '1000', kind: 'service', name: '合成服务号' },
          { id: 'guild:one', ownerId: 'one', kind: 'guild', name: '合成频道联系人' },
          {
            id: 'virtual:persona:p1',
            ownerId: 'p1',
            kind: 'persona',
            sessionId: null,
            name: '合成克隆',
          },
          {
            id: 'assistant:assistant-one',
            ownerId: 'assistant',
            kind: 'assistant',
            sessionId: 'assistant-one',
            name: '合成助手对话',
          },
        ])}
      />
    </>
  ) : (
    <Fixture />
  ),
);
