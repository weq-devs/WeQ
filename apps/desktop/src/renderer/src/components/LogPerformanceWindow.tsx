import { lazy, Suspense, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Activity, LockKeyhole, ScrollText, X } from 'lucide-react';
import {
  useLogPerformanceWindow,
  type MonitorWindowRequest,
  type MonitorTab,
} from '../state/logPerformanceWindow';
import { MONITOR_WINDOWS } from '../../../shared/monitor_window';
import { useToolWindow } from '../hooks/useCompositionWindow';
import { RenderDocumentContext } from '../lib/renderDocument';
import { useAppLock } from '../state/lock';
import { TabActivity } from './RetainedTabs';
import { Modal } from './Dialog';
import { HoverTooltip } from './HoverTooltip';
import '../styles/log-performance.css';

const PerformanceMonitor = lazy(() => import('./settings/PerformanceMonitor'));
const LogViewer = lazy(() =>
  import('./settings/LogViewerPanel').then((module) => ({ default: module.LogViewerPanel })),
);

function MonitorWindow({ tab, request }: { tab: MonitorTab; request: MonitorWindowRequest }) {
  const locked = useAppLock((state) => state.locked);
  const options = MONITOR_WINDOWS[tab];
  const title = tab === 'performance' ? '性能监视' : '日志查看';
  const tool = useToolWindow({
    ...options,
    bodyClass: 'weq-log-performance-body',
    initialWindow: request.popup,
  });
  const hadPopup = useRef(Boolean(request.popup));
  useEffect(() => {
    if (tool.popup) hadPopup.current = true;
    else if (hadPopup.current && !tool.fallback)
      useLogPerformanceWindow.getState().dismiss(tab, request.generation);
  }, [tool.popup, tool.fallback, tab, request.generation]);
  const close = () => {
    tool.close();
    useLogPerformanceWindow.getState().dismiss(tab, request.generation);
  };
  const content = (
    <div className="weq-log-performance-window" hidden={locked} inert={locked}>
      <header className="weq-monitor-head">
        <h2>
          {tab === 'performance' ? <Activity size={17} /> : <ScrollText size={17} />}
          {title}
        </h2>
        <div className="weq-monitor-head-actions">
          <button type="button" title="关闭监视窗口" aria-label="关闭监视窗口" onClick={close}>
            <X size={17} />
          </button>
        </div>
      </header>
      <div className="weq-monitor-panel" role="region" aria-label={title}>
        <Suspense
          fallback={
            <div className="weq-monitor-loading" role="status">
              正在加载…
            </div>
          }
        >
          {tab === 'performance' ? <PerformanceMonitor /> : <LogViewer />}
        </Suspense>
      </div>
    </div>
  );
  const body = (
    <TabActivity active={!locked}>
      {content}
      {locked && (
        <div className="weq-monitor-locked" role="status">
          <LockKeyhole size={24} />
          应用已锁定
        </div>
      )}
    </TabActivity>
  );
  if (tool.popup && !tool.popup.closed)
    return createPortal(
      <RenderDocumentContext.Provider value={tool.popup.document}>
        {body}
        <HoverTooltip />
      </RenderDocumentContext.Provider>,
      tool.popup.document.body,
    );
  if (tool.fallback)
    return (
      <Modal presentation="page" title={title} onClose={close} className="weq-monitor-fallback">
        {body}
      </Modal>
    );
  return null;
}

export function LogPerformanceWindowHost() {
  const requests = useLogPerformanceWindow((state) => state.requests);
  return (
    <>
      {(['performance', 'logs'] as const).map((tab) => {
        const request = requests[tab];
        return request ? (
          <MonitorWindow key={`${tab}-${request.generation}`} tab={tab} request={request} />
        ) : null;
      })}
    </>
  );
}
