import { createRoot } from 'react-dom/client';
import { GlobalSettingsSection } from '../../src/renderer/src/components/settings/GlobalSettingsSection';
import { TitleBar } from '../../src/renderer/src/im-template/template/TitleBar';
import { TitleBarSearch } from '../../src/renderer/src/components/TitleBarSearch';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
Object.assign(window, { windowControlsTheme: useThemeStore });
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).get('surface') === 'main' ? (
    <div
      className={`app-shell-root${window.electron?.process.platform === 'darwin' ? ' is-mac' : ''}`}
    >
      <TitleBar
        user={{
          id: 'fixture',
          identityLabel: 'QQ',
          identityValue: '10001',
          username: '合成账号',
          displayName: '合成账号',
          avatarUrl: null,
        }}
        search={<TitleBarSearch persistent query="" onQueryChange={() => {}} />}
      />
    </div>
  ) : (
    <main
      style={{
        padding: 24,
        maxWidth: 1000,
        margin: 'auto',
        height: '100%',
        overflow: 'auto',
        background: 'var(--weq-chat-bg)',
      }}
    >
      <GlobalSettingsSection />
    </main>
  ),
);
