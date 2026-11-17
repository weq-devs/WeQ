import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { RendererErrorBoundary } from '../../src/renderer/src/components/RendererErrorBoundary';
import { publishRemoteStartup } from '../../src/renderer/src/lib/remoteStartup';
import { observeRemoteStartupSurface } from '../../src/renderer/src/lib/remoteStartupSurface';

const Workspace = lazy(() => import('./remote-startup-recovery.workspace'));
const root = document.getElementById('root')!;
publishRemoteStartup({ state: 'loading', message: '正在加载界面模块' });
observeRemoteStartupSurface(root, '.app-shell-root', () =>
  publishRemoteStartup({ state: 'ready' }),
);
createRoot(root).render(
  <RendererErrorBoundary>
    <Suspense fallback={<div data-weq-startup-pending>正在加载界面模块</div>}>
      <Workspace />
    </Suspense>
  </RendererErrorBoundary>,
);
