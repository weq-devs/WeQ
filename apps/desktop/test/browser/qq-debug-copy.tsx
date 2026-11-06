import { createRoot } from 'react-dom/client';
import { QqDebugCopy } from '../../src/renderer/src/components/QqDebugCopy';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { setFixture } from './qq-debug-copy.stub';
import { SelectScreen } from '../../src/renderer/src/views/bootstrap/SelectScreen';
import { useViewState } from '../../src/renderer/src/state/view';
import {
  RestrictedModeHost,
  RestrictedModeIndicator,
} from '../../src/renderer/src/components/RestrictedMode';
import { useRestrictedMode } from '../../src/renderer/src/state/restrictedMode';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/settings-controls.css';

ensureThemeInitialized();
Object.assign(window, {
  debugCopyQa: { store: useThemeStore, setFixture, restrictedStore: useRestrictedMode },
});
useViewState.getState().enterSelect('existing');
const startup = new URLSearchParams(location.search).has('startup');
const restricted = new URLSearchParams(location.search).has('restricted');
const startupOffline = new URLSearchParams(location.search).has('startup-offline');
if (restricted && !startupOffline) useViewState.setState({ view: 'main', openedUin: '10001' });
createRoot(document.getElementById('root')!).render(
  startup ? (
    <>
      <SelectScreen
        install={{
          qqExePath: '/fixture/QQ.app',
          wrapperNodePath: '/fixture/wrapper.node',
          loginDbPath: '/fixture/login.db',
          tencentFilesRoot: '/fixture/QQ',
          version: '合成版本',
          userDataPath: '/fixture/QQ',
          hasQqExe: true,
          hasWrapper: true,
          hasUserData: true,
          hasLoginDb: true,
        }}
      />
      <DialogHost />
    </>
  ) : restricted ? (
    <>
      {!startupOffline && <RestrictedModeIndicator />}
      <RestrictedModeHost />
      <DialogHost />
    </>
  ) : (
    <main
      style={{
        width: 'min(100%, 520px)',
        margin: '0 auto',
        padding: 20,
        boxSizing: 'border-box',
        background: 'var(--weq-chat-bg)',
      }}
    >
      <h2 style={{ fontSize: 18, margin: '0 0 16px' }}>QQ 调试副本</h2>
      <QqDebugCopy onCheck={async () => {}} />
      <DialogHost />
    </main>
  ),
);
