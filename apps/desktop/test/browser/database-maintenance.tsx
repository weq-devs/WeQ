import { createRoot } from 'react-dom/client';
import { DbRepairPanel } from '../../src/renderer/src/components/DbRepairPanel';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { HoverTooltip } from '../../src/renderer/src/components/HoverTooltip';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { maintenanceQa } from './database-maintenance.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/db-repair-window.css';

ensureThemeInitialized();
Object.assign(window, { maintenanceQa: { ...maintenanceQa, theme: useThemeStore } });
document.body.className = 'weq-db-repair-window-body';
createRoot(document.getElementById('root')!).render(
  <>
    <div className="weq-db-repair-native">
      <DbRepairPanel
        currentUin="synthetic"
        accounts={[{ uin: 'synthetic', configId: 'source', name: '合成账号', avatarUrl: '' }]}
        onRefreshAccounts={() => {}}
      />
    </div>
    <DialogHost />
    <HoverTooltip />
  </>,
);
