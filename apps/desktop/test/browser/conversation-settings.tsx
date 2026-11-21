import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationSettingsDialog } from '../../src/renderer/src/components/ConversationSettingsDialog';
import { ToastHost } from '../../src/renderer/src/components/Toast';
import type { ConversationSettingsSection } from '../../src/renderer/src/lib/conversationSettingsNavigation';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });
Object.assign(window, { settingsTheme: useThemeStore });
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const group = new URLSearchParams(location.search).has('group');
function App() {
  const [initialSection, setInitialSection] = useState<ConversationSettingsSection | null>('qq');
  return (
    <QueryClientProvider client={query}>
      <button type="button" onClick={() => setInitialSection('qq')}>
        会话设置
      </button>
      {initialSection && (
        <ConversationSettingsDialog
          kind={group ? 'group' : 'c2c'}
          conv={group ? '12345' : 'u_fixture'}
          title={'用于检查长名称的联系人'.repeat(4)}
          initialSection={initialSection}
          onClose={() => setInitialSection(null)}
          onReopen={setInitialSection}
        />
      )}
      <ToastHost />
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
