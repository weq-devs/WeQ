import { create } from 'zustand';

/** 固定权重表示启动阶段，不推测剩余秒数；阶段内有真实计数时按比例推进。 */
export const STARTUP_STAGES = {
  resources: { percent: 5, end: 10, label: '正在加载启动界面' },
  restore: { percent: 10, end: 20, label: '正在检查恢复状态' },
  environment: { percent: 20, end: 35, label: '正在检查启动环境' },
  account: { percent: 35, end: 55, label: '正在打开账号' },
  identity: { percent: 55, end: 80, label: '正在准备账号资料' },
  workspace: { percent: 80, end: 90, label: '正在加载会话界面' },
  painting: { percent: 90, end: 99, label: '正在绘制 WeQ 界面' },
  ready: { percent: 100, end: 100, label: '启动完成' },
} as const;
export type StartupStage = keyof typeof STARTUP_STAGES;

export function startupPercent(stage: StartupStage, fraction = 0): number {
  const step = STARTUP_STAGES[stage];
  const measured = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return Math.round(step.percent + (step.end - step.percent) * measured);
}

export const useStartupProgress = create(() => ({
  active: true,
  stage: 'resources' as StartupStage,
  percent: STARTUP_STAGES.resources.percent as number,
}));

export function advanceStartup(stage: StartupStage, fraction = 0): void {
  const current = useStartupProgress.getState();
  if (!current.active) return;
  const percent = startupPercent(stage, fraction);
  // StrictMode 重挂载、迟到的查询和预热回调都不能让整条进度倒退。
  if (
    percent < current.percent ||
    STARTUP_STAGES[stage].percent < STARTUP_STAGES[current.stage].percent
  )
    return;
  useStartupProgress.setState({ stage, percent });
}

export function finishStartup(): void {
  const current = useStartupProgress.getState();
  if (!current.active || current.stage !== 'ready') return;
  useStartupProgress.setState({ active: false });
  window.weq?.debugLog?.('info', '应用已就绪', { scope: 'desktop-main', event: 'app-ready' });
}
