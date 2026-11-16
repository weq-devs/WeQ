import { lazy, Suspense, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Database, LockKeyhole, X } from 'lucide-react';
import { useDatabaseBrowserWindow, type BrowserRequest } from '../state/databaseBrowserWindow';
import { DATABASE_BROWSER_WINDOW } from '../../../shared/database_window';
import { useToolWindow } from '../hooks/useCompositionWindow';
import { RenderDocumentContext } from '../lib/renderDocument';
import { useAppLock } from '../state/lock';
import { TabActivity } from './RetainedTabs';
import { Modal } from './Dialog';
import { HoverTooltip } from './HoverTooltip';
import { ToastHost } from './Toast';
import '../styles/database-browser-window.css';

const DatabaseBrowser = lazy(() => import('./DatabaseBrowser'));

export function DatabaseBrowserWindowRequest({ onRequested }: { onRequested?: () => void }) {
  const requested = useRef(onRequested);
  useEffect(() => {
    useDatabaseBrowserWindow.getState().open();
    requested.current?.();
  }, []);
  return null;
}

function BrowserWindow({ request }: { request: BrowserRequest }) {
  const locked = useAppLock((state) => state.locked);
  const tool = useToolWindow({
    ...DATABASE_BROWSER_WINDOW,
    bodyClass: 'weq-database-browser-body',
    initialWindow: request.popup,
  });
  const hadPopup = useRef(Boolean(request.popup));
  useEffect(() => {
    if (tool.popup) hadPopup.current = true;
    else if (hadPopup.current && !tool.fallback)
      useDatabaseBrowserWindow.getState().dismiss(request.generation);
  }, [tool.popup, tool.fallback, request.generation]);
  const close = () => {
    tool.close();
    useDatabaseBrowserWindow.getState().dismiss(request.generation);
  };
  const body = (
    <TabActivity active={!locked}>
      <div className="weq-database-browser-window" hidden={locked} inert={locked}>
        {!tool.fallback && (
          <header>
            <h2>
              <Database size={17} />
              数据库浏览
            </h2>
            <button
              type="button"
              className="weq-set-iconbtn"
              title="关闭数据库浏览"
              aria-label="关闭数据库浏览"
              onClick={close}
            >
              <X size={17} />
            </button>
          </header>
        )}
        <Suspense fallback={<div role="status">正在加载数据库浏览…</div>}>
          <DatabaseBrowser />
        </Suspense>
        <ToastHost />
        <HoverTooltip />
      </div>
      {locked && (
        <div className="weq-database-browser-locked" role="status">
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
      </RenderDocumentContext.Provider>,
      tool.popup.document.body,
    );
  if (tool.fallback)
    return (
      <Modal
        presentation="page"
        title="数据库浏览"
        onClose={close}
        className="weq-database-browser-fallback"
      >
        {body}
      </Modal>
    );
  return null;
}

export function DatabaseBrowserWindowHost() {
  const request = useDatabaseBrowserWindow((state) => state.request);
  return request ? <BrowserWindow key={request.generation} request={request} /> : null;
}
