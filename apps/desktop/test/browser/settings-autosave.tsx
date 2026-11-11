import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import {
  SettingsResetProvider,
  SettingsResetButton,
} from '../../src/renderer/src/components/settings/SettingsReset';
import {
  Card,
  SectionHeader,
  SettingsScopeContext,
} from '../../src/renderer/src/components/settings/controls';
import { Globe } from 'lucide-react';
import { QzonePaginationSettings } from '../../src/renderer/src/components/settings/QzonePaginationSettings';
import { CallRecordingSection } from '../../src/renderer/src/components/settings/CallRecordingSection';
import { ComponentAppearance } from '../../src/renderer/src/components/settings/ComponentAppearance';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import { state } from './settings-autosave.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-navigation.css';
import '../../src/renderer/src/styles/settings-responsive.css';
import '../../src/renderer/src/styles/page-chrome.css';
useThemeStore.getState().hydrate();
Object.assign(window, { autosaveQa: state, themeQa: useThemeStore });
function App() {
  const [page, setPage] = useState('qzone');
  return (
    <main style={{ maxWidth: 850, margin: '0 auto', padding: 16 }}>
      <nav style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        {['qzone', 'call-recording', 'appearance'].map((id) => (
          <button type="button" className="weq-set-btn" key={id} onClick={() => setPage(id)}>
            {id}
          </button>
        ))}
      </nav>
      <div className="weq-workspace-page">
        <div className="weq-settings-page weq-settings-body" key={page}>
          <SettingsResetProvider page={page}>
            {page === 'qzone' ? (
              <div className="weq-set">
                <SettingsScopeContext.Provider
                  value={{ label: '当前账号', detail: '当前账号的空间浏览设置。' }}
                >
                  <SectionHeader
                    title="QQ 空间"
                    icon={<Globe size={16} />}
                    desc="浏览与在线翻页设置。"
                  />
                </SettingsScopeContext.Provider>
                <QzonePaginationSettings />
                <Card title="只读信息">当前状态正常</Card>
                <SectionHeader title="嵌入分区" pageReset={false} />
              </div>
            ) : page === 'call-recording' ? (
              <CallRecordingSection />
            ) : (
              <>
                <SectionHeader title="主题与背景" />
                <div className="weq-settings-appearance-card">
                  <div className="weq-settings-appearance-head">
                    <strong>基础模式</strong>
                    <SettingsResetButton card="theme-mode" />
                  </div>
                </div>
                <ComponentAppearance />
              </>
            )}
          </SettingsResetProvider>
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
