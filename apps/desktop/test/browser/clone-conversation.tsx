import { createRoot } from 'react-dom/client';
import { CloneChatPanel } from '../../src/renderer/src/views/agentlab/CloneChatPanel';
import { GroupChatPanel } from '../../src/renderer/src/views/agentlab/GroupChatPanel';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
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
  }
}
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
};
const group = new URLSearchParams(location.search).has('group');
createRoot(document.getElementById('root')!).render(
  <ContentSelectionProvider>
    <style>{`html,body,#root{height:100%;margin:0}#root{display:flex;min-width:0}.weq-clone-conversation{height:100dvh}`}</style>
    {group ? (
      <GroupChatPanel
        {...shared}
        groupId="g"
        personaList={[persona]}
        profileByUid={new Map()}
        faceDescToId={new Map()}
        onDeleted={noop}
      />
    ) : (
      <CloneChatPanel
        {...shared}
        personaId="p"
        persona={persona}
        clonedUin="20001"
        modelLabel="合成模型"
        onOpenSettings={noop}
      />
    )}
  </ContentSelectionProvider>,
);
