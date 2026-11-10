import { createRoot } from 'react-dom/client';
import { SelectScreen } from '../../src/renderer/src/views/bootstrap/SelectScreen';
import { BootstrapShell } from '../../src/renderer/src/views/BootstrapView';
import { RestrictedModeHost } from '../../src/renderer/src/components/RestrictedMode';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/bootstrap-select.css';

ensureThemeInitialized();
Object.assign(window, { accessQa: { store: useThemeStore, viewStore: useViewState } });
useViewState.getState().enterSelect('existing');
function Fixture() {
  return (
    <BootstrapShell showWindowActions={false}>
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
    </BootstrapShell>
  );
}
createRoot(document.getElementById('root')!).render(
  <>
    <Fixture />
    <RestrictedModeHost />
  </>,
);
