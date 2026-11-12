import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { useWebConnection } from '../state/webConnection';
import { useToast } from './Toast';
import '../styles/web-connection.css';

type RemoteConnectionState = 'connected' | 'network' | 'connection';
declare global {
  interface Window {
    weqRemoteConnection?: { state: RemoteConnectionState; recovery?: number };
  }
}
const NOTICE_KEY = 'remote-connection';

function nativeConnectionState(): RemoteConnectionState | undefined {
  const state = window.weqRemoteConnection?.state;
  return state === 'connected' || state === 'network' || state === 'connection' ? state : undefined;
}

export function WebConnectionStatus() {
  const status = useWebConnection((state) => state.status);
  const recovery = useWebConnection((state) => state.recovery);
  const previousRecovery = useRef(recovery);
  const queryClient = useQueryClient();
  const [visible, setVisible] = useState(false);
  const [nativeState, setNativeState] = useState(nativeConnectionState);
  const [shellReady, setShellReady] = useState(() =>
    Boolean(window.weqRemoteShell?.connectionFailed),
  );
  const [nativeRecovery, setNativeRecovery] = useState(0);
  const previousNativeRecovery = useRef(0);
  const warned = useRef(false);

  useEffect(() => {
    const changed = () => {
      setNativeState(nativeConnectionState());
      setShellReady(Boolean(window.weqRemoteShell?.connectionFailed));
      const recovery = window.weqRemoteConnection?.recovery;
      if (typeof recovery === 'number' && Number.isSafeInteger(recovery) && recovery >= 0)
        setNativeRecovery(recovery);
    };
    window.addEventListener('weq-remote-connection', changed);
    window.addEventListener('weq-remote-shell-ready', changed);
    changed();
    return () => {
      window.removeEventListener('weq-remote-connection', changed);
      window.removeEventListener('weq-remote-shell-ready', changed);
      useToast.getState().resolve(NOTICE_KEY);
    };
  }, []);

  useEffect(() => {
    if (!nativeState) return;
    const toast = useToast.getState();
    if (nativeState !== 'connected') {
      warned.current = true;
      toast.push({
        key: NOTICE_KEY,
        tone: 'warning',
        durationKind: 'long',
        ttl: 0,
        title: nativeState === 'network' ? '网络已断开，恢复后自动重连' : '连接已中断，正在重连…',
      });
    } else if (warned.current || nativeRecovery > previousNativeRecovery.current) {
      warned.current = false;
      toast.push({ key: NOTICE_KEY, tone: 'success', title: '连接已恢复' });
    }
    previousNativeRecovery.current = nativeRecovery;
  }, [nativeState, nativeRecovery]);

  useEffect(() => {
    if (shellReady && nativeState && status !== 'connected')
      window.weqRemoteShell?.connectionFailed?.();
  }, [nativeState, shellReady, status]);

  useEffect(() => {
    if (recovery === previousRecovery.current) return;
    previousRecovery.current = recovery;
    // 只补查当前挂载的读取；订阅由 tRPC 恢复，不重放发送等 mutation。
    void queryClient.invalidateQueries({ refetchType: 'active' });
  }, [recovery, queryClient]);

  useEffect(() => {
    setVisible(false);
    if (nativeState || status === 'connected') return;
    const timer = window.setTimeout(() => setVisible(true), 1500);
    return () => window.clearTimeout(timer);
  }, [nativeState, status]);

  if (!visible || status === 'connected') return null;
  return (
    <div className="weq-web-connection" role="status" aria-live="polite">
      <WifiOff size={18} aria-hidden />
      <span>{status === 'connecting' ? '正在连接电脑…' : '实时连接已断开，正在重连…'}</span>
    </div>
  );
}
