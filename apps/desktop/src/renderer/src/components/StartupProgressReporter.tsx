import { useLayoutEffect } from 'react';
import { useViewState } from '../state/view';
import { useStartupProgress, advanceStartup, finishStartup } from '../state/startupProgress';
import { observeRemoteStartupSurface } from '../lib/remoteStartupSurface';

/** 最后的绘制阶段留一条不遮挡内容的进度条，不等待次要业务列表。 */
export function StartupProgressReporter() {
  const view = useViewState((state) => state.view);
  const homeStage = useViewState((state) => state.homeStage);
  const progress = useStartupProgress();
  useLayoutEffect(() => {
    if (!progress.active) return;
    const root = document.getElementById('root');
    if (!root) return;
    if (view === 'main') advanceStartup('workspace');
    else if (homeStage === 'booting') return;
    let frame = 0;
    const stop = observeRemoteStartupSurface(
      root,
      view === 'main' ? '.app-shell-root' : '[data-weq-startup-surface]',
      () => {
        advanceStartup('ready');
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(finishStartup);
        });
      },
      (message) => {
        if (message === '正在绘制 WeQ 界面') advanceStartup('painting');
      },
      '[data-weq-startup-page]',
    );
    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, [view, homeStage, progress.active]);
  if (!progress.active || progress.percent < 90) return null;
  return (
    <div
      className="weq-startup-final-progress"
      role="progressbar"
      aria-label="启动进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress.percent}
    >
      <div style={{ width: `${progress.percent}%` }} />
    </div>
  );
}
