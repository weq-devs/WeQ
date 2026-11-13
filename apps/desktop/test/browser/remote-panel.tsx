import { createRoot } from 'react-dom/client';
import { RemotePanel } from '../../src/renderer/src/components/settings/RemotePanel';
import { HoverTooltip } from '../../src/renderer/src/components/HoverTooltip';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';

const noop = () => {};
ensureThemeInitialized();
Object.assign(window, { remotePanelQa: useThemeStore });
createRoot(document.getElementById('root')!).render(
  <>
    <style>{`html,body,#root{margin:0;min-height:100%;height:auto;overflow:auto}main{padding:20px;max-width:900px;margin:auto}`}</style>
    <main>
      <RemotePanel
        data={{
          available: true,
          helperInstalled: true,
          enabled: true,
          network: { state: 'online', addresses: ['https://192.168.1.8:7691'] },
          invitationExpiresAt: null,
          pending: [],
          devices: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              name: 'WeQ Remote iOS',
              scope: 'web:access',
              approvedAt: Date.now() - 86_400_000,
              lastSeenAt: Date.now(),
              deviceInfo: {
                platform: 'ios',
                model: 'iPhone17,1',
                osVersion: '26.1',
                appVersion: '1.0.0b3',
                appBuild: '11',
              },
              lastConnection: { ip: '100.64.0.7', route: 'tailscale' },
            },
            {
              id: '00000000-0000-4000-8000-000000000002',
              name: 'Android 测试设备（较长名称用于窄屏展示检查）',
              scope: 'web:access',
              approvedAt: Date.now() - 7 * 86_400_000,
              lastSeenAt: Date.now() - 3_600_000,
              deviceInfo: {
                platform: 'android',
                model: 'Example Manufacturer Phone Model',
                osVersion: '16',
                appVersion: '1.0.0b3',
                appBuild: '9',
              },
              lastConnection: { ip: '192.168.1.12', route: 'lan' },
            },
            { id: 'legacy-device', name: '旧版手机', approvedAt: 1, lastSeenAt: null },
          ],
        }}
        qr={null}
        busy={false}
        error={null}
        onToggle={noop}
        onLogin={noop}
        onInvite={noop}
        onDecide={noop}
        onRevoke={noop}
      />
    </main>
    <HoverTooltip />
  </>,
);
