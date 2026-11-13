import { createRoot } from 'react-dom/client';
import { BootstrapShell } from '../../src/renderer/src/views/BootstrapView';
import { SelectScreen } from '../../src/renderer/src/views/bootstrap/SelectScreen';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/workspace-tools.css';

/**
 * Remote 首次进入「添加账号」页：电脑侧还没有可用账号。
 * 这里只用来验 FS 能力说明与文案，不涉及选择流程本身。
 */
ensureThemeInitialized();
useViewState.getState().enterSelect('new');
Object.assign(window, { remoteSelectQa: { theme: useThemeStore } });

createRoot(document.getElementById('root')!).render(
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
  </BootstrapShell>,
);
