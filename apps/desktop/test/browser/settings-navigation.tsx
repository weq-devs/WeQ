import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PageSnapshots } from '../../src/renderer/src/components/PageSnapshots';
import { SettingsDialog } from '../../src/renderer/src/components/SettingsDialog';
import { WorkspacePages, WorkspaceContent } from '../../src/renderer/src/components/WorkspacePages';
import { useSettingsNavigation } from '../../src/renderer/src/hooks/useSettingsNavigation';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
Object.assign(window, { settingsNavigationQa: { theme: useThemeStore } });

function Fixture() {
  const [view, setView] = useState('settings');
  const [open, setOpen] = useState(true);
  const navigation = useSettingsNavigation();
  return (
    <QueryClientProvider client={queryClient}>
      <PageSnapshots scope="settings-navigation-fixture">
        <WorkspacePages navigationKey={view}>
          <div
            className="weq-web-shell"
            style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}
          >
            <nav aria-label="测试导航">
              <button type="button" onClick={() => navigation.navigate(() => setView('messages'))}>
                消息
              </button>
              <button type="button" onClick={() => setOpen(true)}>
                打开设置
              </button>
            </nav>
            <WorkspaceContent>
              <p>消息页面</p>
            </WorkspaceContent>
            {open && (
              <SettingsDialog
                open
                initialSection={location.search === '?display=1' ? 'message-display' : 'onebot'}
                onClose={() => setOpen(false)}
                navigationGuard={navigation.guard}
                onOpenMaintenance={() => {}}
                onOpenRecalls={() => {}}
              />
            )}
          </div>
        </WorkspacePages>
      </PageSnapshots>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
