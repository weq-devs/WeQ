import { createRoot } from 'react-dom/client';
import { BackupSection, backupApi } from '../../src/renderer/src/components/settings/BackupSection';
import { GlobalSettingsSection } from '../../src/renderer/src/components/settings/GlobalSettingsSection';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { maintenanceCalls } from './maintenance-trpc.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();
const applied = {
  id: 'synthetic-result',
  status: 'applied' as const,
  completedAt: '2026-11-05T00:00:00Z',
  applied: ['settings'],
  skipped: [],
  warnings: [],
  clientPending: false,
};
const api: typeof backupApi = {
  ...backupApi,
  inventory: async () => ({
    accounts: [],
    cloneScopes: [],
    restore: { pending: null, result: null },
    canPickFile: true,
    canRestart: false,
    maxArchiveBytes: 260 * 1024 * 1024,
    chunkBytes: 65536,
  }),
  defaults: async () => applied,
};
Object.assign(window, { maintenanceQa: { calls: maintenanceCalls, store: useThemeStore } });
createRoot(document.getElementById('root')!).render(
  <>
    <style>{`html,body,#root{height:auto;min-height:100%;margin:0;overflow:auto}.maintenance-fixture{max-width:760px;margin:auto;padding:20px;box-sizing:border-box;color:var(--weq-fg-primary);background:var(--weq-chat-bg)}.maintenance-fixture>div{margin-bottom:24px}`}</style>
    <main className="maintenance-fixture">
      <div data-storage>
        <GlobalSettingsSection section="storage" />
      </div>
      <BackupSection api={api} />
    </main>
    <DialogHost />
  </>,
);
