import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatShell } from '../../src/renderer/src/im-template/template/chatShell';
import type { MainView } from '../../src/renderer/src/im-template/template/types';
import {
  ContactNoticeDialog,
  GroupNoticeDialog,
} from '../../src/renderer/src/components/ContactNoticeDialogs';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { WorkspacePages } from '../../src/renderer/src/components/WorkspacePages';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

const noop = () => {};
const user = {
  id: 'fixture',
  username: 'fixture',
  displayName: '合成账号',
  identityLabel: 'QQ',
  identityValue: '10001',
  avatarUrl: null,
};
ensureThemeInitialized();
Object.assign(window, {
  navigationQa: {
    theme: (value: 'light' | 'dark') => useThemeStore.getState().setPreference(value),
    accent: (value: string) => useThemeStore.getState().setAccent(value),
  },
});

function Fixture() {
  const [view, setView] = useState<MainView>('contacts');
  const [notice, setNotice] = useState<'friend' | 'group' | null>(null);
  const [contactTab, setContactTab] = useState<'friends' | 'groups'>('friends');
  const changeView = (next: MainView) => {
    setNotice(null);
    setView(next);
  };
  return (
    <ContentSelectionProvider>
      <WorkspacePages navigationKey={view}>
        <ChatShell
          user={user}
          view={view}
          query=""
          contactTab={contactTab}
          activeNotice={notice}
          sidebarWidth={280}
          mainOpen={Boolean(notice)}
          messageBadgeCount={0}
          contactBadgeCount={0}
          friendNoticeCount={0}
          groupNoticeCount={0}
          showTools={false}
          sidebarContent={<p>合成联系人</p>}
          mainContent={
            notice === 'friend' ? (
              <ContactNoticeDialog open requests={[]} onClose={() => setNotice(null)} />
            ) : notice === 'group' ? (
              <GroupNoticeDialog open requests={[]} onClose={() => setNotice(null)} />
            ) : (
              <main data-navigation-view={view}>{view}</main>
            )
          }
          onViewChange={changeView}
          onGoHome={() => changeView('home')}
          onQueryChange={noop}
          onContactTabChange={setContactTab}
          onSidebarWidthChange={noop}
          onOpenSettings={noop}
          onOpenCollection={() => changeView('collections')}
          onOpenDressUp={noop}
          onOpenProfile={noop}
          onOpenAbout={noop}
          onOpenInvite={noop}
          onOpenWonderfulTools={noop}
          onOpenAntiRecall={noop}
          onOpenDbRepair={noop}
          onOpenQzoneAlbum={noop}
          onOpenFriendNotices={() => setNotice('friend')}
          onOpenGroupNotices={() => setNotice('group')}
        />
      </WorkspacePages>
    </ContentSelectionProvider>
  );
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Fixture />
  </QueryClientProvider>,
);
