import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PageSnapshots } from '../../src/renderer/src/components/PageSnapshots';
import { SettingsDialog } from '../../src/renderer/src/components/SettingsDialog';
import {
  WorkspaceContent,
  WorkspacePage,
  WorkspacePages,
} from '../../src/renderer/src/components/WorkspacePages';
import { ContactProfileDialog } from '../../src/renderer/src/im-template/template/profilePanes';
import {
  noopChatShellHistoryAdapter,
  useChatShellController,
} from '../../src/renderer/src/im-template/template/shellController';
import type { Contact } from '../../src/renderer/src/im-template/template/types';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
Object.assign(window, { profileSettingsQa: { theme: useThemeStore } });
const person: Contact = {
  id: 'u_self',
  uid: 'u_self',
  username: 'synthetic',
  displayName: '合成本人',
  nick: '合成本人',
  identityLabel: 'QQ',
  identityValue: '10001',
  avatarUrl: null,
  createdAt: '',
};
const contacts = [person];
const directory = {
  selfUin: '10001',
  selfUid: 'u_self',
  friends: new Map(),
  friendsComplete: true,
  groups: new Map(),
};
function Tool() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" data-source-tool onClick={() => setCount(count + 1)}>
      {count}
    </button>
  );
}
function Fixture() {
  const shell = useChatShellController({
    contacts,
    conversations: [],
    conversationPrefs: {},
    initialActiveConversationId: null,
    initialView: 'messages',
    sidebarWidthStorageKey: 'profile-settings-fixture',
    history: noopChatShellHistoryAdapter,
    onReadConversation: () => {},
  });
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState(new URLSearchParams(location.search).has('tool'));
  return (
    <WorkspacePages
      suspended={shell.profileReturnPending}
      navigationKey={`${shell.view}:${shell.selectedContactId ?? ''}`}
      onNavigate={() => setOpen(false)}
    >
      <style>{'html,body,#root{height:100%;margin:0;overflow:hidden}'}</style>
      <main style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <nav aria-label="测试导航" style={{ display: 'flex', gap: 8, padding: 8 }}>
          <button type="button" onClick={() => shell.openContactDetails(person)}>
            我的资料
          </button>
          <button type="button" onClick={() => setOpen(true)}>
            打开设置
          </button>
        </nav>
        <WorkspaceContent>
          {shell.view === 'contacts' ? (
            <ContactProfileDialog contact={person} embedded onClose={shell.backContact} />
          ) : (
            <p data-original-page>原消息页</p>
          )}
        </WorkspaceContent>
        {tool && (
          <WorkspacePage title="来源工具" onClose={() => setTool(false)}>
            <Tool />
          </WorkspacePage>
        )}
        {open && (
          <SettingsDialog
            open
            onClose={() => setOpen(false)}
            onOpenMaintenance={() => {}}
            onOpenRecalls={() => {}}
          />
        )}
      </main>
    </WorkspacePages>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PageSnapshots scope="profile-settings-fixture">
      <RelationshipDirectoryContext.Provider value={directory}>
        <Fixture />
      </RelationshipDirectoryContext.Provider>
    </PageSnapshots>
  </QueryClientProvider>,
);
