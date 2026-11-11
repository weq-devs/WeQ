import { useState } from 'react';
import { CloudSun } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { ChatPane } from '../../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../../src/renderer/src/im-template/template/demoData';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ConversationDirectoryContext } from '../../src/renderer/src/lib/conversationDirectory';
import { PROJECT_GROUP_IDS } from '../../src/shared/project_groups';
import { ChatHeader } from '../../src/renderer/src/components/ChatHeader';
import { MobileWebNavigation } from '../../src/renderer/src/components/MobileWebNavigation';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';
import '../../src/renderer/src/styles/workspace-tools.css';

const demo = createTemplateDemoData();
const noop = () => {};
const calls: string[] = [];
const record = (name: string) => () => calls.push(name);
window.weqRemoteShell = { openMenu: record('连接菜单') };
function Fixture() {
  const [home, setHome] = useState(false);
  const [kind, setKind] = useState<'direct' | 'group'>('direct');
  const [active, setActive] = useState(true);
  const [alignment, setAlignment] = useState(false);
  const source = demo.conversations.find((row) => row.type === kind)!;
  const conversation =
    source.type === 'group'
      ? {
          ...source,
          id: PROJECT_GROUP_IDS[0]!,
          group: {
            ...source.group,
            id: PROJECT_GROUP_IDS[0]!,
            name: '用于验证标题截断的合成群聊名称与更多工具',
          },
        }
      : source.type === 'direct'
        ? {
            ...source,
            id: 'u_fixture',
            otherUser: {
              ...source.otherUser,
              id: 'u_fixture',
              displayName: '用于验证标题截断的合成联系人名称',
            },
          }
        : source;
  Object.assign(window, {
    chatHeaderQa: {
      calls,
      kind: setKind,
      active: setActive,
      alignment: setAlignment,
      home: setHome,
    },
  });
  if (alignment) {
    const status = (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
        <CloudSun size={16} aria-hidden />
        <span>在线 - 今日天气</span>
      </span>
    );
    return (
      <section className="chat-pane">
        <ChatHeader
          title={<span className="chat-title-text">测试联系人</span>}
          status={status}
          mobileStatus={status}
          actions={null}
          onBack={noop}
        />
      </section>
    );
  }
  return (
    <div className="app-shell-root weq-web-shell" style={{ height: '100dvh' }}>
      {home ? (
        <MobileWebNavigation
          user={{ ...demo.user, displayName: '用于验证标题截断的合成联系人名称' }}
          view="messages"
          hidden={false}
          query=""
          onQueryChange={noop}
          messageBadgeCount={0}
          contactBadgeCount={0}
          onViewChange={noop}
          onOpenSettings={noop}
          onOpenDressUp={noop}
          onOpenCollection={noop}
        />
      ) : (
        <ConversationDirectoryContext.Provider
          value={{ virtual: [], onCreate: noop, onVirtual: noop, onAnalyze: record('分析') }}
        >
          <ContentSelectionProvider>
            <ChatPane
              user={demo.user}
              conversation={conversation}
              messages={[]}
              draft=""
              tabActive={active}
              onBack={record('返回')}
              onDraftChange={noop}
              onDraftClear={noop}
              onSend={noop}
              onSearchChatRecords={record('搜索')}
              onOpenRoamingBackfill={record('漫游')}
              onAddMessage={record('添加')}
              onViewDeleted={record('删除')}
              onViewRecalled={record('撤回')}
              onOpenConversationSettings={record('设置')}
              onOpenGroupBug={record('反馈')}
            />
          </ContentSelectionProvider>
        </ConversationDirectoryContext.Provider>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
