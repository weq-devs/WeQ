import { createRoot } from 'react-dom/client';
import { EnhancementPacksSection } from '../../src/renderer/src/components/settings/EnhancementPacksSection';
import { RecognitionSettingsSection } from '../../src/renderer/src/components/settings/RecognitionSettingsSection';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
Object.assign(window, { enhancementTheme: useThemeStore });
createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 900, margin: 'auto', padding: 16 }}>
    {new URLSearchParams(location.search).has('recognition') ? (
      <RecognitionSettingsSection />
    ) : (
      <EnhancementPacksSection />
    )}
    <DialogHost />
  </main>,
);
