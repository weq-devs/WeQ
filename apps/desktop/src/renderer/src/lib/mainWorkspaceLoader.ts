import { useStartupProgress } from '../state/startupProgress';
import { useAccountSwitch } from '../state/accountSwitch';
import { IS_WEB } from './target';

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

/** Remote 在恢复检查时并行取代码，桌面沿用身份预热；均不提前挂载或发业务查询。 */
export function installMainWorkspacePreload() {
  const warm = () => {
    const stage = useStartupProgress.getState().stage;
    if (
      (IS_WEB && stage === 'restore') ||
      stage === 'identity' ||
      useAccountSwitch.getState().active
    )
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
