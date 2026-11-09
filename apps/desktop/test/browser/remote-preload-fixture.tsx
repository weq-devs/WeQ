import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatShell } from '../../src/renderer/src/im-template/template/chatShell';
import { ChatSidebarContent } from '../../src/renderer/src/im-template/template/chatSidebarContent';
import type { MainView } from '../../src/renderer/src/im-template/template/types';
import { MobileSidebarPages } from '../../src/renderer/src/components/MobileSidebarPages';
import { QzoneWorkspace } from '../../src/renderer/src/views/QzoneView';
import { useMobilePageSettled } from '../../src/renderer/src/hooks/useMobilePageSettled';
import { resetMobileRoot } from '../../src/renderer/src/hooks/useMobileNavigation';
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
const contacts = Array.from({ length: 60 }, (_, i) => ({
  ...user,
  id: `u_fixture_${i}`,
  displayName: `合成联系人 ${i}`,
  identityValue: String(10001 + i),
}));
ensureThemeInitialized();
function Fixture() {
  const [view, setView] = useState<MainView>('messages');
  const ready = useMobilePageSettled(view === 'qzone', '10001');
  const navigate = (next: MainView) => {
    resetMobileRoot();
    setView(next);
  };
  Object.assign(window, { remotePreloadQa: { navigate, theme: useThemeStore } });
  return (
    <ChatShell
      user={user}
      view={view}
      query=""
      contactTab="friends"
      activeNotice={null}
      sidebarWidth={320}
      mainOpen={false}
      messageBadgeCount={0}
      contactBadgeCount={0}
      friendNoticeCount={0}
      groupNoticeCount={0}
      onViewChange={navigate}
      onOpenSettings={noop}
      onOpenCollection={noop}
      onOpenDressUp={noop}
      onOpenProfile={noop}
      onOpenAbout={noop}
      onOpenInvite={noop}
      onOpenWonderfulTools={noop}
      onOpenAntiRecall={noop}
      onOpenDbRepair={noop}
      onOpenQzoneAlbum={noop}
      onQueryChange={noop}
      onOpenFriendNotices={noop}
      onOpenGroupNotices={noop}
      onContactTabChange={noop}
      onSidebarWidthChange={noop}
      sidebarContent={
        <MobileSidebarPages
          activeKey={view}
          renderPage={(page) => (
            <ChatSidebarContent
              view={page}
              user={user}
              contactTab="friends"
              conversations={[]}
              activeConversationId={null}
              selectedGroupConversationId={null}
              selectedContactId={null}
              conversationPrefs={{}}
              drafts={{}}
              contacts={contacts}
              query=""
              onSelectConversation={noop}
              onSelectContact={noop}
              onSelectGroup={noop}
            />
          )}
        />
      }
      mainContent={
        view === 'qzone' ? (
          <QzoneWorkspace active readEnabled={ready} selfUin="10001" nickname="合成账号" />
        ) : null
      }
    />
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
