import { useEffect } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useAccountSwitch } from '../state/accountSwitch';
import { publishRemoteStartup } from '../lib/remoteStartup';
import { IS_WEB } from '../lib/target';

/** 复用首屏查询缓存；HTML 完成不代表恢复检查、账号探测和首屏数据已完成。 */
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
  const profile = trpc.account.getSelfProfile.useQuery(undefined, { enabled });
  const recent = trpc.account.listRecentContacts.useQuery(undefined, { enabled });
  useEffect(() => {
    if (!IS_WEB) return;
    const error =
      native.error || (enabled ? config.error || profile.error || recent.error : install.error);
    if (error) {
      publishRemoteStartup({ state: 'error', message: error.message });
    } else if (native.data) {
      publishRemoteStartup({ state: 'action-required' });
    } else if (
      switching ||
      stage === 'booting' ||
      (view === 'bootstrap' && !install.isSuccess) ||
      (enabled && (config.isLoading || profile.isLoading || recent.isLoading))
    ) {
      publishRemoteStartup({ state: 'loading', message: '正在准备 WeQ 页面' });
    } else {
      // 无已打开账号时，账号选择页本身就是可操作的正式页面。
      publishRemoteStartup({ state: 'ready' });
    }
  }, [
    view,
    stage,
    switching,
    enabled,
    config.error,
    config.isLoading,
    profile.error,
    profile.isLoading,
    recent.error,
    recent.isLoading,
    native.error,
    native.data,
    install.error,
    install.isSuccess,
  ]);
  return null;
}
