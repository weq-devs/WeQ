import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PageSnapshots } from '../../src/renderer/src/components/PageSnapshots';
import { SettingsDialog } from '../../src/renderer/src/components/SettingsDialog';
import { WorkspacePages, WorkspaceContent } from '../../src/renderer/src/components/WorkspacePages';
import { useSettingsNavigation } from '../../src/renderer/src/hooks/useSettingsNavigation';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import type { SectionId } from '../../src/renderer/src/components/SettingsDialog';
import type { SettingsSearchTarget } from '../../src/renderer/src/components/settings/searchTarget';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const params = new URLSearchParams(location.search);
const initialSection = (params.get('section') as SectionId | null) ?? undefined;
const searchItem = params.get('item');
const searchSettingId = params.get('settingId');
const searchTarget: SettingsSearchTarget | null =
  searchItem || searchSettingId
    ? {
        section: initialSection ?? 'startup',
        revision: 1,
        ...(searchItem ? { item: searchItem } : {}),
        ...(searchSettingId ? { settingId: searchSettingId } : {}),
      }
    : null;

useViewState.setState({ openedUin: '10001' });
Object.assign(window, {
  settingsAuditQa: { theme: useThemeStore, view: useViewState },
});

function Fixture() {
  const [view] = useState('settings');
  const [open, setOpen] = useState(true);
  const navigation = useSettingsNavigation();
  return (
    <QueryClientProvider client={queryClient}>
      <PageSnapshots scope="settings-audit-fixture">
        <WorkspacePages navigationKey={view}>
          <div
            className="weq-web-shell"
            style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}
          >
            <nav aria-label="测试导航">
              <button type="button" onClick={() => setOpen(true)}>
                打开设置
              </button>
            </nav>
            <WorkspaceContent>
              <p>基础页面</p>
            </WorkspaceContent>
            {open && (
              <SettingsDialog
                open
                initialSection={initialSection}
                searchTarget={searchTarget}
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
