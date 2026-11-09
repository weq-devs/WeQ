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
          devices: [],
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
