import { createRoot } from 'react-dom/client';
import { SettingsDialog } from '../../src/renderer/src/components/SettingsDialog';
import { DatabaseDamagedDialog } from '../../src/renderer/src/components/DatabaseDamagedDialog';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import {
  acceptPreferences,
  bindAccountState,
  acceptAccountState,
} from '../../src/renderer/src/lib/clientPreferences';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

useViewState.setState({ openedUin: '10001' });
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'notification-fixture' };
bindAccountState(binding);
acceptAccountState({ revision: 0, values: {}, records: {} }, binding);
acceptPreferences(
  { revision: 1, values: { messageNotifications: false, applicationBadge: true }, records: {} },
  false,
);
Object.assign(window, { notificationTheme: useThemeStore });
const dialogState = { closes: 0 };
Object.assign(window, { notificationDialogState: dialogState });
createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100dvh', display: 'flex' }}>
    {new URL(location.href).searchParams.get('surface') === 'damage' ? (
      <DatabaseDamagedDialog
        event={{
          reason: 'database-damaged',
          kind: 'confirmed',
          uin: '10001',
          title: '合成数据库异常',
          message: '合成检查结果',
          details: [],
          failures: [],
          reportPath: null,
        }}
        onClose={() => dialogState.closes++}
        onOpenSettings={() => {}}
        onOpenRepair={() => {}}
      />
    ) : (
      <SettingsDialog
        open
        initialSection="mail"
        onClose={() => {}}
        onOpenMaintenance={() => {}}
        onOpenRecalls={() => {}}
      />
    )}
  </div>,
);
