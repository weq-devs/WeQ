import { createRoot } from 'react-dom/client';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import { MergedSessionPanel } from '../../src/renderer/src/components/sidebar/MergedSessionPanel';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { createTemplateDemoData } from '../support/templateDemoData';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();
Object.assign(window, { conversationStatesQa: { store: useThemeStore } });
const seed = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
const conversations = ['10001', '10002', '10003'].map((id, index) => ({
  ...seed,
  id,
  group: { ...seed.group, id, name: `合成测试群 ${index + 1}` },
  updatedAt: `2030-01-0${3 - index}T00:00:00Z`,
  lastMessage: null,
  unreadCount: index,
  preference: { pinned: false, muted: false, blocked: false },
}));

createRoot(document.getElementById('root')!).render(
  <ContentSelectionProvider>
    <style>{`
      html,body,#root{height:100%;margin:0}
      .states-fixture{height:100%;background:var(--weq-bg-surface)}
      .states-fixture .app-shell{display:block;width:340px;min-width:0;height:100%}
      .states-fixture .weq-conversation-directory{height:100%}
      @media(max-width:600px){.states-fixture .app-shell{width:100%}}
    `}</style>
    <div className="states-fixture app-shell-root weq-web-shell">
      <div className="app-shell">
        <ConversationList
          conversations={conversations}
          activeConversationId="10001"
          preferences={{}}
          drafts={{}}
          onSelect={() => {}}
        />
      </div>
      <MergedSessionPanel
        kind="groupAssistant"
        conversations={conversations}
        groupAssistantIds={new Set(conversations.map((row) => row.id))}
        anchorX={360}
        anchorY={250}
        onBack={() => {}}
        onSelectConversation={() => {}}
      />
    </div>
  </ContentSelectionProvider>,
);
