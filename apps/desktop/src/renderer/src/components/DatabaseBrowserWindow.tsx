import { lazy, Suspense, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Database, LockKeyhole } from 'lucide-react';
import { useDatabaseBrowserWindow, type BrowserRequest } from '../state/databaseBrowserWindow';
import { DATABASE_BROWSER_WINDOW } from '../../../shared/database_window';
import { useToolWindow } from '../hooks/useCompositionWindow';
import { RenderDocumentContext } from '../lib/renderDocument';
import { useAppLock } from '../state/lock';
import { TabActivity } from './RetainedTabs';
import { Modal } from './Dialog';
import { PageShell } from './PageShell';
import { HoverTooltip } from './HoverTooltip';
import { NotificationSourceProvider } from '../lib/notificationNavigation';
import { notificationSource } from '../lib/notificationNavigation.shared';
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
        <PageShell
          title="数据库浏览"
          icon={<Database size={17} />}
          onClose={close}
          closeLabel="关闭数据库浏览"
        >
          <Suspense fallback={<div role="status">正在加载数据库浏览…</div>}>
            <NotificationSourceProvider
              source={notificationSource(
                { kind: 'local', open: () => useDatabaseBrowserWindow.getState().open() },
                '返回数据库浏览器',
              )}
            >
              <DatabaseBrowser />
            </NotificationSourceProvider>
          </Suspense>
        </PageShell>
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
        <HoverTooltip />
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
