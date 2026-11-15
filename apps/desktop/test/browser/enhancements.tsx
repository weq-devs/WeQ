import { createRoot } from 'react-dom/client';
import { EnhancementPacksSection } from '../../src/renderer/src/components/settings/EnhancementPacksSection';
import { RecognitionSettingsSection } from '../../src/renderer/src/components/settings/RecognitionSettingsSection';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { useEnhancementUpdates } from '../../src/renderer/src/hooks/useEnhancementUpdates';
import { onOpenSettingsRequest } from '../../src/renderer/src/lib/callSettingsBridge';
import { SettingsResetProvider } from '../../src/renderer/src/components/settings/SettingsReset';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
Object.assign(window, { enhancementTheme: useThemeStore });
onOpenSettingsRequest((section) => {
  document.body.dataset.settingsSection = section;
});
function UpdateNotice() {
  useEnhancementUpdates();
  return null;
}
createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 900, margin: 'auto', padding: 16 }}>
    {new URLSearchParams(location.search).has('notice') ? <UpdateNotice /> : null}
    {new URLSearchParams(location.search).has('recognition') ? (
      <RecognitionSettingsSection />
    ) : (
      <SettingsResetProvider page="enhancement-packs">
        <EnhancementPacksSection />
      </SettingsResetProvider>
    )}
    <DialogHost />
  </main>,
);
