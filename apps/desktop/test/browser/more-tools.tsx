import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatShell } from '../../src/renderer/src/im-template/template/chatShell';
import { WorkspaceContent, WorkspacePages } from '../../src/renderer/src/components/WorkspacePages';
import { WorkspaceTools } from '../../src/renderer/src/components/WorkspaceTools';
import { WorkspaceMenuButton } from '../../src/renderer/src/components/WorkspaceMenuButton';
import { CompositionWorkspace } from '../../src/renderer/src/components/mergeForward/CompositionWorkspace';
import { useCompositionWindow } from '../../src/renderer/src/hooks/useCompositionWindow';
import { useViewState } from '../../src/renderer/src/state/view';
import { MailWorkspace } from '../../src/renderer/src/views/MailView';
import {
  useChatShellController,
  noopChatShellHistoryAdapter,
} from '../../src/renderer/src/im-template/template/shellController';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { MainView } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';

const noop = () => {};
const user = {
  id: 'fixture',
  username: 'fixture',
  displayName: '合成昵称',
  identityValue: '10001',
  identityLabel: 'QQ',
  avatarUrl: null,
};
ensureThemeInitialized();
useViewState.setState({ openedUin: 'fixture' });
Object.assign(window, {
  moreToolsQa: {
    theme: (value: 'light' | 'dark') => useThemeStore.getState().setPreference(value),
  },
});

function Fixture() {
  const shell = useChatShellController({
    conversations: [],
    contacts: [],
    conversationPrefs: {},
    initialActiveConversationId: null,
    initialView: 'more',
    sidebarWidthStorageKey: 'fixture:more-width',
    history: noopChatShellHistoryAdapter,
  });
  const view: MainView = shell.view;
  const composition = useCompositionWindow();
  return (
    <WorkspacePages navigationKey={view}>
      <ChatShell
        user={user}
        view={view}
        contactTab="friends"
        activeNotice={null}
        mainOpen={false}
        sidebarWidth={320}
        query=""
        onQueryChange={noop}
        onViewChange={shell.switchView}
        messageBadgeCount={0}
        contactBadgeCount={0}
        friendNoticeCount={0}
        groupNoticeCount={0}
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
        onOpenFriendNotices={noop}
        onOpenGroupNotices={noop}
        onContactTabChange={noop}
        onSidebarWidthChange={noop}
        railFooterContent={() => <WorkspaceMenuButton />}
        sidebarContent={null}
        mainContent={
          <WorkspaceContent>
            <p data-secondary-page={view}>合成业务页</p>
            {view === 'mail' && <MailWorkspace active selfUin="10001" onUnreadChange={noop} />}
          </WorkspaceContent>
        }
      />
      <WorkspaceTools
        accountScope="fixture"
        footerControls={null}
        onOpenAnalysis={noop}
        onOpenComposition={composition.open}
      />
      <CompositionWorkspace
        popup={composition.popup}
        fallback={composition.fallback}
        onClose={composition.close}
        onPopOut={composition.open}
        self={{ uid: 'u_fixture', uin: '10001', name: '合成昵称' }}
        targets={[]}
        sendAvailable={false}
        onForward={async () => {}}
        onSend={async () => {}}
        onOpenTarget={noop}
      />
    </WorkspacePages>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Fixture />
  </QueryClientProvider>,
);
