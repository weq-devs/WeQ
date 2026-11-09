import { useEffect } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useAccountSwitch } from '../state/accountSwitch';
import { publishRemoteStartup } from '../lib/remoteStartup';
import { IS_WEB } from '../lib/target';
import { observeRemoteStartupSurface } from '../lib/remoteStartupSurface';

/** 启动只等待必要配置与真实界面，业务列表在界面内异步加载。 */
export function RemoteStartupReporter() {
  const view = useViewState((state) => state.view);
  const stage = useViewState((state) => state.homeStage);
  const switching = useAccountSwitch((state) => state.active);
  const enabled = IS_WEB && view === 'main' && !switching;
  const native = trpc.bootstrap.nativeStatus.useQuery(undefined, { enabled: IS_WEB });
  const install = trpc.bootstrap.describeInstall.useQuery(undefined, {
    enabled: IS_WEB && view === 'bootstrap' && stage !== 'booting' && native.data === null,
  });
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled });
  useEffect(() => {
    if (!IS_WEB) return;
    const error = native.error || (enabled ? config.error : install.error);
    if (error) {
      publishRemoteStartup({ state: 'error', message: error.message });
    } else if (native.data) {
      publishRemoteStartup({ state: 'action-required' });
    } else if (
      switching ||
      stage === 'booting' ||
      (view === 'bootstrap' && !install.isSuccess) ||
      (enabled && config.isLoading)
    ) {
      publishRemoteStartup({
        state: 'loading',
        message:
          native.data === undefined
            ? '正在检查网页启动环境'
            : stage === 'booting'
              ? '正在恢复账号工作区'
              : '正在初始化工作区',
      });
    } else {
      publishRemoteStartup({ state: 'loading', message: '正在绘制 WeQ 界面' });
      const root = document.getElementById('root');
      if (!root) return;
      return observeRemoteStartupSurface(
        root,
        view === 'main' ? '.app-shell-root' : '.weq-account-workspace',
        () => publishRemoteStartup({ state: 'ready' }),
        (message) => publishRemoteStartup({ state: 'loading', message }),
      );
    }
  }, [
    view,
    stage,
    switching,
    enabled,
    config.error,
    config.isLoading,
    native.error,
    native.data,
    install.error,
    install.isSuccess,
  ]);
  return null;
}
