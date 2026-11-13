import { useStartupProgress } from '../state/startupProgress';
import { useAccountSwitch } from '../state/accountSwitch';

let pending: Promise<{ default: typeof import('../views/MainView').MainView }> | undefined;

export function loadMainWorkspace() {
  pending ??= import('../views/MainView')
    .then((module) => ({ default: module.MainView }))
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

/** 已确认进入账号时并行取代码，不挂载工作区、不发业务查询，也不等待它阻塞预热。 */
export function installMainWorkspacePreload() {
  const warm = () => {
    if (useStartupProgress.getState().stage === 'identity' || useAccountSwitch.getState().active)
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
