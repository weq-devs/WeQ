import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileWebNavigation } from '../../src/renderer/src/components/MobileWebNavigation';
import { ChatHeader } from '../../src/renderer/src/components/ChatHeader';
import { ConversationActionsMenu } from '../../src/renderer/src/components/ConversationActionsMenu';
import { Ellipsis } from 'lucide-react';
import { MobileNavigationRuntime } from '../../src/renderer/src/components/MobileNavigationRuntime';
import {
  WorkspacePages,
  WorkspaceContent,
  WorkspacePage,
} from '../../src/renderer/src/components/WorkspacePages';
import { useChatShellController } from '../../src/renderer/src/im-template/template/shellController';
import { mobileBack, useMobileBack } from '../../src/renderer/src/hooks/useMobileNavigation';
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

function SettingsPage({ close }: { close: () => void }) {
  const [category, setCategory] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useMobileBack(
    category,
    () => setCategory(false),
    30,
    () => ref.current,
  );
  return (
    <WorkspacePage title="设置" onClose={close}>
      <div ref={ref} className="fixture-settings">
        <header className="weq-mobile-settings-header">
          <button
            onClick={() => {
              if (!mobileBack()) close();
            }}
          >
            返回
          </button>
          <strong>{category ? '外观' : '设置'}</strong>
        </header>
        {category ? (
          <input aria-label="设置输入" defaultValue="保留草稿" />
        ) : (
          <button onClick={() => setCategory(true)}>外观分类</button>
        )}
      </div>
    </WorkspacePage>
  );
}

function Fixture() {
  const root = useRef<HTMLDivElement>(null);
  useMobileWebViewport(root, true);
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState(false);
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
    },
  });
  return (
    <div
      ref={root}
      className="app-shell-root weq-web-shell"
      data-mobile-detail={shell.mainOpen || settings || undefined}
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
        <WorkspaceContent>
          <div className="app-shell">
            <aside className="sidebar">
              <button
                className="fixture-conversation"
                onClick={() => shell.selectConversation('fixture-chat')}
              >
                合成会话
              </button>
            </aside>
            <main className="chat-main">
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
            </main>
          </div>
        </WorkspaceContent>
        {settings && <SettingsPage close={() => setSettings(false)} />}
      </WorkspacePages>
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
      <style>{`html,body,#root{height:100%;margin:0}.fixture-settings{height:100%;background:var(--weq-bg-surface);color:var(--weq-fg-primary)}.fixture-chat{padding:24px}.fixture-conversation{width:100%;min-height:76px;text-align:left;padding:16px;border:0;border-bottom:1px solid var(--weq-border-subtle);background:var(--weq-bg-surface);color:var(--weq-fg-primary)}.fixture-settings>button,.fixture-settings>input{margin:24px;min-height:44px}.chat-header{display:flex;align-items:center;min-height:calc(52px + env(safe-area-inset-top));padding:0 12px}.chat-title{flex:1}.chat-actions{display:flex}.chat-main{background:var(--weq-chat-bg,var(--background))}.weq-workspace-content,.weq-workspace-split,.weq-workspace-primary{height:100%}.weq-workspace-page-host{height:100%}textarea{width:100%;box-sizing:border-box;min-height:100px}`}</style>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
