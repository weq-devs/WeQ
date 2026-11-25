import { useToast } from '../components/Toast.shared';
import { useAccountSwitch } from '../state/accountSwitch';
import { useViewState } from '../state/view';
import { accountBinding, ACCOUNT_STATE_CHANGED } from './clientPreferences';

/** 主文档拥有横幅。账号切换同步改写投递目标，旧回调即使尚未卸载也不能写入。 */
export function installAccountBannerRouting() {
  const sync = () => {
    const { view, openedUin } = useViewState.getState();
    const binding = accountBinding();
    useToast
      .getState()
      .setAccount(
        view === 'main' &&
          !useAccountSwitch.getState().active &&
          binding?.expectedAccountUin === openedUin
          ? binding
          : null,
      );
  };
  sync();
  const stopView = useViewState.subscribe(sync);
  const stopSwitch = useAccountSwitch.subscribe(sync);
  window.addEventListener(ACCOUNT_STATE_CHANGED, sync);
  return () => {
    stopView();
    stopSwitch();
    window.removeEventListener(ACCOUNT_STATE_CHANGED, sync);
  };
}
