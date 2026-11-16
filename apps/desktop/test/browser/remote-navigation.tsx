import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileWebNavigation } from '../../src/renderer/src/components/MobileWebNavigation';
import { ChatHeader } from '../../src/renderer/src/components/ChatHeader';
import { ConversationActionsMenu } from '../../src/renderer/src/components/ConversationActionsMenu';
import { Ellipsis } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsDialog } from '../../src/renderer/src/components/SettingsDialog';
import { Modal } from '../../src/renderer/src/components/Dialog';
import {
  ContactNoticeDialog,
  GroupNoticeDialog,
} from '../../src/renderer/src/components/ContactNoticeDialogs';
import { MobileNavigationRuntime } from '../../src/renderer/src/components/MobileNavigationRuntime';
import { WorkspacePages, WorkspaceContent } from '../../src/renderer/src/components/WorkspacePages';
import { useChatShellController } from '../../src/renderer/src/im-template/template/shellController';
import { useMobileWebViewport } from '../../src/renderer/src/hooks/useMobileWebViewport';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import type { Conversation } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';
import '../../src/renderer/src/styles/workspace-tools.css';

const noop = () => {};
const user = {
  id: 'fixture',
  username: 'fixture',
  displayName: '合成昵称',
  identityLabel: 'QQ',
  identityValue: '10001',
  avatarUrl: null,
};
const conversations: Conversation[] = [
  {
    id: 'fixture-chat',
    type: 'direct',
    otherUser: user,
    group: null,
    members: [],
    updatedAt: '',
    lastMessage: null,
  },
];
const history = {
  isMobileShell: () => true,
  shouldAutoSelectConversation: () => false,
  replaceShell: noop,
  pushShellDetail: noop,
  pushConversationDetail: noop,
};
ensureThemeInitialized();
window.weqRemoteShell = {
  openMenu: () => {
    document.body.dataset.menuCalls = String(Number(document.body.dataset.menuCalls ?? 0) + 1);
  },
};

function Fixture() {
  const root = useRef<HTMLDivElement>(null);
  useMobileWebViewport(root, true);
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState(false);
  const shell = useChatShellController({
    conversations,
    contacts: [],
    conversationPrefs: {},
    initialActiveConversationId: null,
    initialView: 'messages',
    sidebarWidthStorageKey: 'fixture:width',
    history,
  });
  Object.assign(window, {
    remoteNavigationQa: {
      theme: (value: 'light' | 'dark') => useThemeStore.getState().setPreference(value),
      root: () => shell.switchView('messages'),
      dialog: () => setDialog(true),
    },
  });
  return (
    <div
      ref={root}
      className="app-shell-root weq-web-shell"
      data-mobile-detail={shell.mainOpen || settings || undefined}
      data-mobile-root-view={shell.view}
      data-mobile-workspace={shell.view === 'qzone' || undefined}
    >
      <MobileNavigationRuntime root={root} />
      <MobileWebNavigation
        user={user}
        view={shell.view}
        hidden={shell.mainOpen || settings}
        query=""
        onQueryChange={noop}
        messageBadgeCount={0}
        contactBadgeCount={0}
        onViewChange={shell.switchView}
        onOpenSettings={() => setSettings(true)}
        onOpenDressUp={noop}
        onOpenCollection={noop}
      />
      <WorkspacePages navigationKey={shell.view}>
        <div className="app-shell">
          <aside className="sidebar">
            <div className="sidebar-body">
              <div data-mobile-sidebar-page="messages" hidden={shell.view !== 'messages'}>
                <button
                  className="fixture-conversation"
                  onClick={() => shell.selectConversation('fixture-chat')}
                >
                  合成会话
                </button>
              </div>
              <div data-mobile-sidebar-page="contacts" hidden={shell.view !== 'contacts'}>
                合成联系人
                <button onClick={() => shell.openContactNotice('friend')}>新好友</button>
                <button onClick={() => shell.openContactNotice('group')}>群通知</button>
              </div>
            </div>
          </aside>
          <main className="chat-main">
            <WorkspaceContent>
              {shell.contactNotice ? (
                shell.contactNotice === 'friend' ? (
                  <ContactNoticeDialog open requests={[]} onClose={shell.backContactNotice} />
                ) : (
                  <GroupNoticeDialog open requests={[]} onClose={shell.backContactNotice} />
                )
              ) : (
                <>
                  <ChatHeader
                    title="合成会话"
                    actions={
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="更多会话操作"
                        onClick={() => setMenu(true)}
                      >
                        <Ellipsis size={22} />
                      </button>
                    }
                    onBack={shell.backConversation}
                  />
                  <div className="fixture-chat">
                    <textarea aria-label="消息草稿" defaultValue="未发送的消息" />
                    <button onClick={() => setSettings(true)}>打开设置</button>
                  </div>
                </>
              )}
            </WorkspaceContent>
          </main>
        </div>
        {settings && (
          <SettingsDialog
            open
            onClose={() => setSettings(false)}
            onOpenMaintenance={noop}
            onOpenRecalls={noop}
          />
        )}
      </WorkspacePages>
      <div hidden inert aria-hidden="true">
        {(['messages', 'contacts'] as const).map((view) => (
          <div key={view} data-mobile-root-preview={view}>
            <aside className="sidebar">
              <div className="sidebar-body" />
            </aside>
          </div>
        ))}
        <div data-mobile-root-preview="qzone">
          <main className="chat-main">合成空间</main>
        </div>
      </div>
      {menu && (
        <ConversationActionsMenu
          dropdown
          label="会话操作"
          x={376}
          y={56}
          actions={[]}
          onClose={() => setMenu(false)}
        />
      )}
      <Modal
        open={dialog}
        onClose={() => setDialog(false)}
        dismissOnOutside={false}
        title="侧滑测试弹层"
        labelledBy="swipe-test-dialog"
      >
        <h2 id="swipe-test-dialog">侧滑测试弹层</h2>
        <button type="button">弹层内容</button>
      </Modal>
      <style>{`html,body,#root{height:100%;margin:0}.fixture-settings{height:100%;background:var(--weq-bg-surface);color:var(--weq-fg-primary)}.fixture-chat{padding:24px}.fixture-conversation{width:100%;min-height:76px;text-align:left;padding:16px;border:0;border-bottom:1px solid var(--weq-border-subtle);background:var(--weq-bg-surface);color:var(--weq-fg-primary)}.fixture-settings>button,.fixture-settings>input{margin:24px;min-height:44px}.chat-header{display:flex;align-items:center;min-height:calc(52px + env(safe-area-inset-top));padding:0 12px}.chat-title{flex:1}.chat-actions{display:flex}.chat-main{background:var(--weq-chat-bg,var(--background))}.weq-workspace-content,.weq-workspace-split,.weq-workspace-primary{height:100%}.weq-workspace-page-host{height:100%}textarea{width:100%;box-sizing:border-box;min-height:100px}`}</style>
    </div>
  );
}
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
);
