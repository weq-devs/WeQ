import { createRoot } from 'react-dom/client';
import { BootstrapShell } from '../../src/renderer/src/views/BootstrapView';
import { SelectScreen } from '../../src/renderer/src/views/bootstrap/SelectScreen';
import { ToastHost, useToast } from '../../src/renderer/src/components/Toast';
import { useRestrictedMode } from '../../src/renderer/src/state/restrictedMode';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import { TitleBar } from '../../src/renderer/src/im-template/template/TitleBar';
import { TitleBarSearch } from '../../src/renderer/src/components/TitleBarSearch';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/workspace-tools.css';

ensureThemeInitialized();
useViewState.getState().enterSelect('existing');
useRestrictedMode.setState({
  reasons: [{ code: 'offline', title: 'QQ 不在线', guidance: '登录 QQ' }],
});
useToast.getState().push({ title: '合成受限模式提醒', durationKind: 'long', ttl: 0 });
Object.assign(window, {
  startupQa: { theme: useThemeStore, restricted: useRestrictedMode, toast: useToast },
});
const surface = new URLSearchParams(location.search).get('surface');
createRoot(document.getElementById('root')!).render(
  <>
    {surface === 'main' ? (
      <TitleBar
        user={{
          id: 'fixture',
          identityValue: '10001',
          username: '合成账号',
          displayName: '合成账号',
          avatarUrl: null,
          signature: '合成个性签名',
        }}
        search={<TitleBarSearch persistent query="" onQueryChange={() => {}} />}
      />
    ) : surface === 'loading' ? (
      <BootstrapShell>
        <div />
      </BootstrapShell>
    ) : (
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
    )}
    <ToastHost />
  </>,
);
