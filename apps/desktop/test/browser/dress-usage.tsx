import { useState } from 'react';
import { ConversationSettingsDialog } from '../../src/renderer/src/components/ConversationSettingsDialog';
import type { ConversationSettingsRequest } from '../../src/renderer/src/lib/conversationSettingsNavigation';
import { createRoot } from 'react-dom/client';
import { DressUpDialog } from '../../src/renderer/src/components/DressUpDialog';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { applyDressSkin } from '../../src/renderer/src/lib/dressSkin';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
const params = new URLSearchParams(location.search);
useThemeStore.getState().setPreference(params.get('theme') === 'dark' ? 'dark' : 'light');
useThemeStore.getState().setAccent(params.get('theme') === 'dark' ? '#fff3a1' : '#075c30');
Object.assign(window, { dressUsageQa: { applyDressSkin, theme: useThemeStore } });
function DressUsageFixture() {
  const [settings, setSettings] = useState<ConversationSettingsRequest>();
  return (
    <>
      <DressUpDialog
        initialKind="usage"
        onClose={() => {}}
        onOpenConversationSettings={setSettings}
      />
      {settings ? (
        <ConversationSettingsDialog {...settings} onClose={() => setSettings(undefined)} />
      ) : null}
      <DialogHost />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<DressUsageFixture />);
