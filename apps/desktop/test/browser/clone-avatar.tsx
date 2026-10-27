import { createRoot } from 'react-dom/client';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../../src/renderer/src/im-template/template/demoData';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ConversationDirectoryContext } from '../../src/renderer/src/lib/conversationDirectory';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

const noop = () => {};
const virtual = [
  {
    id: 'virtual:persona:p',
    kind: 'persona' as const,
    ownerId: 'p',
    name: '克隆好友',
    uin: '20001',
  },
  {
    id: 'virtual:persona:empty',
    kind: 'persona' as const,
    ownerId: 'empty',
    name: '无头像克隆好友',
  },
  {
    id: 'virtual:persona:failed',
    kind: 'persona' as const,
    ownerId: 'failed',
    name: '头像加载失败的克隆好友',
    uin: '20009',
  },
  ...[2, 3, 4].map((count) => ({
    id: `virtual:group:${count}`,
    kind: 'group' as const,
    ownerId: String(count),
    name: `${count} 人克隆群`,
    memberUins: Array.from({ length: count }, (_, index) => String(20001 + index)),
  })),
];

createRoot(document.getElementById('root')!).render(
  <div className="weq-web-shell">
    <div className="app-shell">
      <style>{`html,body,#root{margin:0;min-height:100%}.app-shell{display:block;width:100%;height:100vh}.weq-conversation-viewport{height:100vh}`}</style>
      <ContentSelectionProvider>
        <ConversationDirectoryContext.Provider value={{ virtual, onVirtual: noop, onCreate: noop }}>
          <ConversationList
            conversations={createTemplateDemoData().conversations.slice(0, 1)}
            activeConversationId={null}
            preferences={{}}
            drafts={{}}
            onSelect={noop}
          />
        </ConversationDirectoryContext.Provider>
      </ContentSelectionProvider>
    </div>
  </div>,
);
