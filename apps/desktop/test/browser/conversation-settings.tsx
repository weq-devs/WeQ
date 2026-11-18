import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationSettingsDialog } from '../../src/renderer/src/components/ConversationSettingsDialog';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });
Object.assign(window, { settingsTheme: useThemeStore });
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function App() {
  const [open, setOpen] = useState(true);
  return (
    <QueryClientProvider client={query}>
      <button type="button" onClick={() => setOpen(true)}>
        会话设置
      </button>
      {open && (
        <ConversationSettingsDialog
          kind="c2c"
          conv="u_fixture"
          title={'用于检查长名称的联系人'.repeat(4)}
          onClose={() => setOpen(false)}
        />
      )}
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
