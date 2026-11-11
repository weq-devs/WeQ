import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContactHistory } from '../../src/renderer/src/components/ContactHistory';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
ensureThemeInitialized();
useViewState.setState({ openedUin: '99999' });
const qa = { mode: 'ready', setMode: (_mode: string) => {}, theme: useThemeStore };
Object.assign(window, { contactHistoryQa: qa });
function App() {
  const [, update] = useState(0);
  qa.setMode = (mode) => {
    qa.mode = mode;
    update((n) => n + 1);
  };
  return (
    <main style={{ maxWidth: 760, padding: 16, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20 }}>资料历史</h1>
      <ContactHistory entity="group:12345" />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
