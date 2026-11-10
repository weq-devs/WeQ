import { createRoot } from 'react-dom/client';
import { GlobalSettingsSection } from '../../src/renderer/src/components/settings/GlobalSettingsSection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
Object.assign(window, { windowControlsTheme: useThemeStore });
createRoot(document.getElementById('root')!).render(
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
  </main>,
);
