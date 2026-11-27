import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { prefersInlineToolWindow, useToolWindow } from '../../hooks/useCompositionWindow';
import { requestOpenSettings } from '../../lib/callSettingsBridge';
import { lazyPanel } from '../../lib/lazyPanel';
import { notificationSource } from '../../lib/notificationNavigation.shared';
import { trpc } from '../../trpc/client';
import type { CallInfo } from '../CallWindow';
import { useToastApi } from '../Toast.shared';
import { CallWindowLoading } from './CallWindowLoading';

export type CallWindowProps = { initial: CallInfo; onClose: () => void };

export type CallWindowContentProps = {
  info: CallInfo;
  tool: ReturnType<typeof useToolWindow>;
  requestHangup: () => void;
  closeWindow: () => void;
  hangupPending: boolean;
  notificationToast: ReturnType<typeof useToastApi>;
};

const LazyCallWindowContent = lazyPanel<CallWindowContentProps>(
  () => import('../CallWindow').then((module) => ({ default: module.CallWindowContent })),
  ({ tool }) => (
    <CallWindowLoading
      popup={tool.popup}
      inline={tool.fallback && prefersInlineToolWindow()}
      title="语音通话"
      width="min(720px, 100%)"
      className="weq-call-inline"
    />
  ),
);

/** 打开通话窗口和接收状态先于通话界面加载，关窗也能立即结束呼叫。 */
export function CallWindowHost({
  initial,
  onClose,
  Content = LazyCallWindowContent,
}: CallWindowProps & { Content?: ComponentType<CallWindowContentProps> }) {
  const notificationWindow = useRef<Window | null>(null);
  const notificationOrigin = useMemo(
    () =>
      notificationSource(
        {
          kind: 'local',
          open: () => {
            const popup = notificationWindow.current;
            if (popup && !popup.closed) popup.focus();
            else requestOpenSettings('callRecording');
          },
        },
        '返回通话或录音设置',
      ),
    [],
  );
  const notificationToast = useToastApi(notificationOrigin);
  const [info, setInfo] = useState<CallInfo>(initial);
  const finished = info.state === 'ended' || info.state === 'failed';
  const hangup = trpc.call.hangup.useMutation({
    onError: () => {
      hangupRequested.current = false;
    },
  });
  const tool = useToolWindow({
    name: 'weq-call',
    title: 'WeQ · 语音通话',
    width: 400,
    height: 620,
    bodyClass: 'weq-call-window-body',
  });
  useEffect(() => {
    notificationWindow.current = tool.popup;
    return () => {
      notificationWindow.current = null;
    };
  }, [tool.popup]);
  const finishedRef = useRef(finished);
  finishedRef.current = finished;
  const hangupRef = useRef(hangup.mutate);
  hangupRef.current = hangup.mutate;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const hangupRequested = useRef(false);
  const closeRequested = useRef(false);
  const requestHangup = useCallback(() => {
    if (finishedRef.current || hangupRequested.current) return;
    hangupRequested.current = true;
    hangupRef.current();
  }, []);
  const closeWindow = useCallback(() => {
    if (closeRequested.current) return;
    closeRequested.current = true;
    tool.close();
    onCloseRef.current();
  }, [tool.close]);
  const lifecycle = useRef(0);
  useEffect(() => {
    const generation = ++lifecycle.current;
    const popup = closeRequested.current ? null : tool.open();
    if (!popup && !prefersInlineToolWindow() && !closeRequested.current) {
      requestHangup();
      notificationToast.push({
        tone: 'error',
        message: '无法打开通话窗口',
        detail: '已结束本次呼叫，请允许弹出窗口后重试。',
      });
      closeWindow();
    }
    const timer = window.setInterval(() => {
      if (!popup?.closed) return;
      requestHangup();
      closeWindow();
    }, 200);
    return () => {
      window.clearInterval(timer);
      // StrictMode 会立即重挂载；只为真正卸载（切号／退出主界面）挂断。
      queueMicrotask(() => {
        if (lifecycle.current === generation) requestHangup();
      });
    };
  }, [tool.open, requestHangup, closeWindow, notificationToast]);

  // ── 状态订阅 ──
  trpc.call.onCallState.useSubscription(undefined, {
    onData: (next) => {
      const call = next as CallInfo;
      if (call?.state) setInfo((prev) => ({ ...prev, ...call }));
    },
    onError: (error) => console.error('[call] state subscription error', error),
  });

  return (
    <Content
      info={info}
      tool={tool}
      requestHangup={requestHangup}
      closeWindow={closeWindow}
      hangupPending={hangup.isPending}
      notificationToast={notificationToast}
    />
  );
}
