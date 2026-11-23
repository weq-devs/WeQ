import { useStartupProgress } from '../state/startupProgress';
import { useAccountSwitch } from '../state/accountSwitch';
import { IS_WEB } from './target.shared';

let pending: Promise<{ default: typeof import('../views/MainView').MainView }> | undefined;

export function loadMainWorkspace() {
  if (pending) return pending;
  if (IS_WEB) window.dispatchEvent(new Event('weq-remote-workspace-loading'));
  pending = import('../views/MainView')
    .then((module) => ({ default: module.MainView }))
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

/** 确认进入或切换账号后，工作区代码与身份初始化并行准备。 */
export function installMainWorkspacePreload() {
  const warm = () => {
    const stage = useStartupProgress.getState().stage;
    if (stage === 'identity' || useAccountSwitch.getState().active)
      void loadMainWorkspace().catch(() => {});
  };
  const stopProgress = useStartupProgress.subscribe(warm);
  const stopSwitch = useAccountSwitch.subscribe(warm);
  warm();
  return () => {
    stopProgress();
    stopSwitch();
  };
}
