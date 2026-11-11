import { createRoot } from 'react-dom/client';
import { MobileSidebarPages } from '../../src/renderer/src/components/MobileSidebarPages';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../support/templateDemoData';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();
Object.assign(window, { listHeightQa: { store: useThemeStore } });
const seed = createTemplateDemoData().conversations.find((row) => row.type === 'direct')!;
const conversations = Array.from({ length: 200 }, (_, index) => ({
  ...seed,
  id: `fixture-${index}`,
}));

createRoot(document.getElementById('root')!).render(
  <ContentSelectionProvider>
    <style>{`html,body,#root{height:100%;margin:0}.height-fixture{height:100%;display:flex}.height-fixture .app-shell{display:block;width:360px;height:100%;min-width:0}.height-fixture .sidebar{width:100%}@media(max-width:760px){.height-fixture .app-shell{width:100%}}`}</style>
    <div className="height-fixture app-shell-root weq-web-shell">
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-header sidebar-header-no-search" />
          <div className="sidebar-body">
            <MobileSidebarPages
              activeKey="messages"
              renderPage={(view) =>
                view === 'messages' ? (
                  <ConversationList
                    conversations={conversations}
                    activeConversationId={null}
                    preferences={{}}
                    drafts={{}}
                    onSelect={() => {}}
                  />
                ) : null
              }
            />
          </div>
        </aside>
      </div>
    </div>
  </ContentSelectionProvider>,
);
