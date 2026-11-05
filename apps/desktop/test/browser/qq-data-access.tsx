import { createRoot } from 'react-dom/client';
import { SelectScreen } from '../../src/renderer/src/views/bootstrap/SelectScreen';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/bootstrap-select.css';

ensureThemeInitialized();
Object.assign(window, { accessQa: { store: useThemeStore } });
useViewState.getState().enterSelect('new');
function Fixture() {
  return (
    <main className="weq-home-shell" style={{ height: '100dvh' }}>
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
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
