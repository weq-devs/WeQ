import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarHeader } from '../../src/renderer/src/im-template/template/sidebarHeader';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import { ConversationDirectoryContext } from '../../src/renderer/src/lib/conversationDirectory';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

const noop = () => {};
const user = {
  id: 'fixture',
  username: '合成账号',
  displayName: '合成账号',
  identityLabel: 'QQ',
  identityValue: '10001',
  avatarUrl: null,
};
ensureThemeInitialized();
Object.assign(window, { sidebarToolbarQa: { theme: useThemeStore } });
const notices = new URLSearchParams(location.search).has('unread') ? 1 : 0;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <ContentSelectionProvider>
      <style>{`
        html, body, #root { height: auto; min-height: 100%; overflow: auto; }
        .toolbar-fixture { display: flex; flex-wrap: wrap; gap: 24px; padding: 16px; }
        .toolbar-fixture > .sidebar { flex: none; width: 240px; height: 360px; }
      `}</style>
      <div className="toolbar-fixture">
        {(['messages', 'contacts'] as const).map((view) => (
          <aside key={view} className="sidebar" data-testid={view}>
            <SidebarHeader
              user={user}
              view={view}
              query=""
              onQueryChange={noop}
              onOpenProfile={noop}
              onOpenFriendNotices={noop}
              onOpenGroupNotices={noop}
              onRefreshContacts={noop}
              contactTab="friends"
              onContactTabChange={noop}
              showSearch={false}
              activeNotice={null}
              friendNoticeCount={notices}
              groupNoticeCount={notices}
            />
            <div className="sidebar-body">
              {view === 'messages' && (
                <ConversationDirectoryContext.Provider
                  value={{ virtual: [], onVirtual: noop, onCreate: noop, onCalendar: noop }}
                >
                  <ConversationList
                    conversations={[]}
                    activeConversationId={null}
                    preferences={{}}
                    drafts={{}}
                    onSelect={noop}
                  />
                </ConversationDirectoryContext.Provider>
              )}
            </div>
          </aside>
        ))}
      </div>
    </ContentSelectionProvider>
  </QueryClientProvider>,
);
