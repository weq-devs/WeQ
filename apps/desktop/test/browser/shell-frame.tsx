import { createRoot } from 'react-dom/client';
import { AppRail } from '../../src/renderer/src/im-template/template/rail';
import { TitleBar } from '../../src/renderer/src/im-template/template/TitleBar';
import { TitleBarSearch } from '../../src/renderer/src/components/TitleBarSearch';
import { ChatHome } from '../../src/renderer/src/views/ChatHome';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/rail-navigation.css';
import '../../src/renderer/src/styles/titlebar-search.css';
import '../../src/renderer/src/styles/workspace-tools.css';
import '../../src/renderer/src/styles/home-layout.css';

const user = {
  id: 'fixture',
  identityValue: '10001',
  username: '合成账号',
  displayName: '合成账号',
  avatarUrl: null,
  signature: '一段用于检查标题栏省略效果的合成个性签名',
};

ensureThemeInitialized();
useViewState.getState().setOpenedUin('10001');
useThemeStore.getState().setPreference('light');
Object.assign(window, { shellQa: { theme: useThemeStore, view: useViewState } });

const view = 'messages' as const;
createRoot(document.getElementById('root')!).render(
  <div className="app-shell-root is-mac is-desktop-shell" style={{ height: '100dvh' }}>
    <TitleBar
      user={user}
      homeActive
      onGoHome={() => {}}
      search={<TitleBarSearch persistent query="" onQueryChange={() => {}} />}
    />
    <div className="app-shell">
      <AppRail
        user={user}
        view={view}
        onViewChange={() => {}}
        onOpenSettings={() => {}}
        onOpenCollection={() => {}}
        onOpenDressUp={() => {}}
        onOpenProfile={() => {}}
        onOpenAbout={() => {}}
        onOpenInvite={() => {}}
        onOpenWonderfulTools={() => {}}
        onOpenAntiRecall={() => {}}
        onOpenDbRepair={() => {}}
        onOpenQzoneAlbum={() => {}}
        messageBadgeCount={128}
        contactBadgeCount={2}
        mailBadgeCount={3}
      />
      <aside className="sidebar">
        <div className="sidebar-header">
          <button className="weq-rail-button" type="button" title="搜索" aria-label="搜索">
            <span className="rail-tab-icon" />
          </button>
        </div>
        <div className="sidebar-body">
          <div className="conversation-row">
            <span>合成测试群 4</span>
          </div>
        </div>
      </aside>
      <main className="chat-main">
        <ChatHome nickname="合成账号" />
      </main>
    </div>
  </div>,
);
