import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { WarmupSplash } from '../../src/renderer/src/components/WarmupSplash';
import { WorkspaceStartupLoading } from '../../src/renderer/src/components/WorkspaceStartupLoading';
import { observeRemoteStartupSurface } from '../../src/renderer/src/lib/remoteStartupSurface';
import { ensureThemeInitialized } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import { advanceStartup, useStartupProgress } from '../../src/renderer/src/state/startupProgress';
import { StartupProgressReporter } from '../../src/renderer/src/components/StartupProgressReporter';
import { useViewState } from '../../src/renderer/src/state/view';

ensureThemeInitialized();
let finish!: () => void;
const Workspace = lazy(
  () =>
    new Promise<{ default: () => React.ReactElement }>((resolve) => {
      finish = () =>
        resolve({
          default: () => (
            <main className="app-shell-root">
              <button type="button">合成工作区已就绪</button>
            </main>
          ),
        });
    }),
);
const host = document.getElementById('root')!;
const root = createRoot(host);
const qa = {
  ready: false,
  progress: useStartupProgress,
  step(stage: 'restore' | 'open' | 'warmup' | 'workspace') {
    advanceStartup(
      stage === 'open' ? 'account' : stage === 'warmup' ? 'identity' : stage,
      stage === 'warmup' ? 1 : 0,
    );
    if (stage === 'workspace') useViewState.setState({ view: 'main', homeStage: 'home' });
    root.render(
      <>
        {stage === 'workspace' ? (
          <Suspense fallback={<WorkspaceStartupLoading />}>
            <Workspace />
          </Suspense>
        ) : (
          <main className="weq-home-shell weq-initial-startup" data-weq-startup-pending>
            <WarmupSplash
              hint={stage === 'restore' ? '正在检查恢复状态' : '正在打开账号'}
              progress={stage === 'warmup' ? { done: 1, total: 1, pending: null } : null}
            />
          </main>
        )}
        <StartupProgressReporter />
      </>,
    );
  },
  finish() {
    finish();
  },
};
Object.assign(window, { startupFlow: qa });
observeRemoteStartupSurface(host, '.app-shell-root', () => {
  qa.ready = true;
});
qa.step('restore');
