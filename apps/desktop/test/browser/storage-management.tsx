import { createRoot } from 'react-dom/client';
import { GlobalSettingsSection } from '../../src/renderer/src/components/settings/GlobalSettingsSection';
import { Card, SettingsNavigateContext } from '../../src/renderer/src/components/settings/controls';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/backup.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
Object.assign(window, { storageQa: useThemeStore });
createRoot(document.getElementById('root')!).render(
  <>
    <style>{`html,body,#root{height:auto;min-height:100%;margin:0;overflow:auto}.storage-fixture{padding:16px;max-width:900px;margin:auto;background:var(--weq-chat-bg);color:var(--weq-fg-primary)}`}</style>
    <SettingsNavigateContext.Provider value={() => {}}>
      <main className="storage-fixture">
        <section data-cleanup>
          <GlobalSettingsSection section="storage" />
        </section>
        <section data-backup className="weq-set weq-backup">
          <Card title="重置与清除配置">
            <div className="weq-backup-actions">
              <button type="button" className="weq-set-btn weq-set-btn-soft">
                恢复默认设置
              </button>
              <GlobalSettingsSection
                section="storage"
                heading={false}
                storageManagement="configuration"
              />
            </div>
          </Card>
        </section>
      </main>
    </SettingsNavigateContext.Provider>
  </>,
);
