import { createRoot } from 'react-dom/client';
import { RemoteSection } from '../../src/renderer/src/components/settings/RemoteSection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useRemoteEntryFixture } from './remote-entry.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-controls.css';

ensureThemeInitialized();
Object.assign(window, { remoteEntryQa: { theme: useThemeStore, state: useRemoteEntryFixture } });
createRoot(document.getElementById('root')!).render(
  <>
    <style>{`
      html,body,#root{height:auto;min-height:100%;margin:0;overflow:auto}
      main{padding:20px;max-width:900px;margin:auto;background:var(--weq-chat-bg);color:var(--weq-fg-primary)}
    `}</style>
    <main>
      <RemoteSection />
    </main>
  </>,
);
