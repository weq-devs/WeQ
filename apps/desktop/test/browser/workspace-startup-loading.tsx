import { createRoot } from 'react-dom/client';
import { WorkspaceStartupLoading } from '../../src/renderer/src/components/WorkspaceStartupLoading';
import { LoadingIndicator } from '../../src/renderer/src/components/LoadingIndicator';
import { lazyPanel } from '../../src/renderer/src/lib/lazyPanel';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
Object.assign(window, { startupQa: { theme: useThemeStore } });
const Panel = lazyPanel(
  () =>
    new Promise<{ default: () => React.ReactElement }>((resolve) => {
      Object.assign(window, { finishPanel: () => resolve({ default: () => <p>页面已就绪</p> }) });
    }),
);
const surface = new URLSearchParams(location.search).get('surface');
createRoot(document.getElementById('root')!).render(
  surface === 'panel' ? (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <header style={{ height: 48, flexShrink: 0 }}>工具页面</header>
      <Panel />
      <footer style={{ padding: 16 }}>
        <LoadingIndicator>正在读取面板数据…</LoadingIndicator>
      </footer>
    </main>
  ) : (
    <WorkspaceStartupLoading />
  ),
);
