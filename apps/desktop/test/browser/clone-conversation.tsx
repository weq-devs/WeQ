import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { CloneChatPanel } from '../../src/renderer/src/views/agentlab/CloneChatPanel';
import { GroupChatPanel } from '../../src/renderer/src/views/agentlab/GroupChatPanel';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ConversationDirectoryContext } from '../../src/renderer/src/lib/conversationDirectory';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { contrastRatio } from '../../src/shared/theme_colors';
import { PersonaSettingsModal } from '../../src/renderer/src/views/agentlab/PersonaSettingsModal';
import { CloneGenerationPanel } from '../../src/renderer/src/components/settings/CloneGenerationPanel';
import { OverlayAnchorProvider } from '../../src/renderer/src/lib/overlayAnchor';
import { cloneRequests } from './clone-conversation.stub';
import {
  useThemeStore,
  type ThemePreference,
  type ThemeBackground,
} from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/agentlab-workspace.css';

declare global {
  interface Window {
    cloneTheme: (theme: ThemePreference, accent: string, background: ThemeBackground) => void;
    cloneContrast: typeof contrastRatio;
    cloneRequests: () => typeof cloneRequests;
  }
}
window.cloneContrast = contrastRatio;
window.cloneRequests = () => cloneRequests;
window.cloneTheme = (theme, accent, background) => {
  const store = useThemeStore.getState();
  store.setPreference(theme);
  store.setAccent(accent);
  store.setBackground(background);
};
const noop = () => {};
const shared = {
  sessionId: 's',
  selfUin: '10000',
  onBack: noop,
  onSessionCreated: noop,
  onSwitchSession: noop,
  onNewSession: noop,
};
const persona = {
  id: 'p',
  name: '合成好友',
  sourceId: 'u_fixture',
  sourceUin: '20001',
  sourceTitle: '合成样本',
  models: { chat: { providerId: 'fixture', model: 'fixture-model' } },
};
const group = new URLSearchParams(location.search).has('group');
function Fixture() {
  const [settings, setSettings] = useState(false);
  return (
    <ConversationDirectoryContext.Provider
      value={{
        virtual: [{ id: 'virtual:persona:p', kind: 'persona', ownerId: 'p', name: persona.name }],
        onVirtual: noop,
        onCreate: noop,
      }}
    >
      <ContentSelectionProvider>
        <DialogHost />
        <style>{`html,body,#root{height:100%;margin:0}#root{display:flex;min-width:0}`}</style>
        {group ? (
          <GroupChatPanel
            {...shared}
            groupId="g"
            personaList={[
              persona,
              { ...persona, id: 'p2', name: '合成新成员', sourceId: 'u_new', sourceUin: '20002' },
            ]}
            profileByUid={new Map()}
            faceDescToId={new Map()}
            onDeleted={noop}
            onOpenPersonaSettings={() => setSettings(true)}
            personaSettingsOpen={settings}
          />
        ) : (
          <CloneChatPanel
            {...shared}
            personaId="p"
            persona={persona}
            clonedUin="20001"
            modelLabel="合成模型"
            onOpenSettings={() => setSettings(true)}
          />
        )}
        {settings ? (
          <PersonaSettingsModal
            persona={persona}
            fromGroup={group}
            replyContent={<CloneGenerationPanel persona={persona} onSaved={noop} />}
            onClose={() => setSettings(false)}
            onSaved={noop}
          />
        ) : null}
      </ContentSelectionProvider>
    </ConversationDirectoryContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(
  <OverlayAnchorProvider>
    <Fixture />
  </OverlayAnchorProvider>,
);
