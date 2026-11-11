import { WarmupSplash } from './WarmupSplash';

/** 工作区挂载前的各段等待共用整页动画，避免切回纯文字占位。 */
export function WorkspaceStartupLoading() {
  return (
    <div
      role="status"
      data-weq-startup-pending
      className="weq-home-shell h-screen overflow-hidden font-sans text-foreground"
    >
      <WarmupSplash hint="正在加载会话界面" />
    </div>
  );
}
