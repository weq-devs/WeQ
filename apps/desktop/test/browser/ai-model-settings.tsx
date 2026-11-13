import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { IntentSenseSection } from '../../src/renderer/src/components/settings/IntentSenseSection';
import { InteractionProfileSection } from '../../src/renderer/src/components/settings/InteractionProfileSection';
import { ReplySuggestionsSection } from '../../src/renderer/src/components/settings/ReplySuggestionsSection';
import { AgentLabSection } from '../../src/renderer/src/components/settings/AgentLabSection';
import { PageSnapshots } from '../../src/renderer/src/components/PageSnapshots';
import { RetainedTabs } from '../../src/renderer/src/components/RetainedTabs';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
Object.assign(window, { aiSettingsTheme: useThemeStore });
const pages = {
  意图感知: IntentSenseSection,
  互动画像: InteractionProfileSection,
  推荐回复: ReplySuggestionsSection,
  'API 配置': AgentLabSection,
};
function Fixture() {
  const [page, setPage] = useState<keyof typeof pages>('意图感知');
  const Section = pages[page];
  return (
    <main style={{ maxWidth: 900, margin: 'auto', padding: 16 }}>
      <nav>
        {Object.keys(pages).map((name) => (
          <button key={name} type="button" onClick={() => setPage(name as keyof typeof pages)}>
            {name}
          </button>
        ))}
      </nav>
      <PageSnapshots scope="ai-model-settings-qa">
        <RetainedTabs activeKey={page} snapshotKey="settings">
          <Section />
        </RetainedTabs>
      </PageSnapshots>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
