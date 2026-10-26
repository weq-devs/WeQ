import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LockKeyhole, Radio, RefreshCw, X } from 'lucide-react';
import { useToolWindow } from '../hooks/useCompositionWindow';
import { useQQReadActivity } from '../hooks/useQQAutoRefresh';
import { IS_WEB } from '../lib/target';
import { readWithRetry } from '../lib/autoRead';
import { RenderDocumentContext } from '../lib/renderDocument';
import { useCaptureWindow } from '../state/captureWindow';
import { useAppLock } from '../state/lock';
import { client } from '../trpc/client';
import { CapturePanel } from './CapturePanel';
import { TabActivity } from './RetainedTabs';
import { Modal } from './Dialog';
import { ToastHost } from './Toast';
import { HoverTooltip } from './HoverTooltip';
import { QueryError } from './settings/controls';
import '../styles/capture-window.css';

export function CaptureWindowRequest({
  source,
  uin,
  onRequested,
}: {
  source: string;
  uin: string;
  onRequested?: () => void;
}) {
  const initial = useRef({ source, uin, onRequested });
  useEffect(() => {
    useCaptureWindow.getState().open(initial.current.source, initial.current.uin);
    initial.current.onRequested?.();
  }, []);
  return null;
}

function CaptureWindowPanel({ initialUin, onClose }: { initialUin: string; onClose: () => void }) {
  const activity = useQQReadActivity(true, { onlineOnly: IS_WEB });
  const [accounts, setAccounts] = useState<
    Awaited<ReturnType<typeof client.wonderfulTools.overview.query>>
  >([]);
  const [loading, setLoading] = useState(activity.enabled);
  const [error, setError] = useState<string | null>(null);
  const enabled = useRef(activity.enabled);
  enabled.current = activity.enabled;
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!mounted.current || !enabled.current) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError(null);
    try {
      const rows = await readWithRetry(
        () => client.wonderfulTools.overview.query(),
        request.signal,
      );
      if (!request.signal.aborted && mounted.current && enabled.current) setAccounts(rows);
    } catch (error) {
      if (!request.signal.aborted && mounted.current && enabled.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!request.signal.aborted && mounted.current && enabled.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (activity.enabled) void refresh();
    else {
      controller.current?.abort();
      setLoading(false);
    }
    return () => controller.current?.abort();
  }, [activity.enabled, activity.revision, refresh]);
  return (
    <div className="weq-capture-native">
      <header className="weq-capture-window-head">
        <Radio size={17} />
        <h1>QQNT 抓包</h1>
        {loading ? (
          <span className="weq-capture-window-status" role="status">
            读取中…
          </span>
        ) : null}
        <button
          type="button"
          className="weq-set-iconbtn"
          title="刷新 QQ 账号"
          aria-label="刷新 QQ 账号"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </button>
        <button
          type="button"
          className="weq-set-iconbtn"
          title="关闭抓包窗口"
          aria-label="关闭抓包窗口"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {error ? (
        <QueryError
          message={`QQ 账号读取失败：${error}`}
          onRetry={() => void refresh()}
          retryLabel="重新读取 QQ 账号"
          retrying={loading}
        />
      ) : null}
      <div className="weq-capture-window-content">
        <CapturePanel
          initialUin={initialUin}
          accounts={accounts.map((account) => ({
            uin: account.uin,
            name: account.userName,
            avatarUrl: account.avatarUrl,
            pid: account.pid,
          }))}
        />
      </div>
    </div>
  );
}

/** 独立于设置页挂载；请求的完整来源变化时，旧面板和会话一起释放。 */
export function CaptureWindowHost() {
  const request = useCaptureWindow((state) => state.request);
  const locked = useAppLock((state) => state.locked);
  const tool = useToolWindow({
    name: 'weq-capture',
    title: 'WeQ · QQNT 抓包',
    width: 1060,
    height: 780,
    bodyClass: 'weq-capture-window-body',
  });
  const { open, close } = tool;
  useEffect(() => {
    if (request && !useAppLock.getState().locked) open();
    else if (!request) close();
  }, [request, open, close]);
  const dismiss = () => useCaptureWindow.getState().dismiss(request?.source);
  const popup = tool.popup && !tool.popup.closed ? tool.popup : null;
  if (tool.fallback && request && !locked)
    return (
      <Modal width={360} centered onClose={dismiss}>
        <div className="weq-capture-window-error" role="alert">
          <h3>无法打开 QQNT 抓包窗口</h3>
          <button
            type="button"
            className="weq-set-btn"
            onClick={() => {
              if (!useAppLock.getState().locked) open();
            }}
          >
            重新打开
          </button>
        </div>
      </Modal>
    );
  return popup && request
    ? createPortal(
        <RenderDocumentContext.Provider value={popup.document}>
          <TabActivity active={!locked}>
            <div
              key={request.source}
              className="weq-capture-window-surface"
              hidden={locked}
              inert={locked}
            >
              <CaptureWindowPanel initialUin={request.uin} onClose={dismiss} />
              <ToastHost />
              {!locked ? <HoverTooltip /> : null}
            </div>
          </TabActivity>
          {locked ? (
            <div className="weq-capture-window-locked" role="status">
              <LockKeyhole size={24} />
              <span>应用已锁定</span>
            </div>
          ) : null}
        </RenderDocumentContext.Provider>,
        popup.document.body,
      )
    : null;
}
