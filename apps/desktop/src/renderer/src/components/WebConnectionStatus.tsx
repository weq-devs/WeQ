import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { useWebConnection } from '../state/webConnection';
import '../styles/web-connection.css';

export function WebConnectionStatus() {
  const status = useWebConnection((state) => state.status);
  const recovery = useWebConnection((state) => state.recovery);
  const previousRecovery = useRef(recovery);
  const queryClient = useQueryClient();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (recovery === previousRecovery.current) return;
    previousRecovery.current = recovery;
    // 只补查当前挂载的读取；订阅由 tRPC 恢复，不重放发送等 mutation。
    void queryClient.invalidateQueries({ refetchType: 'active' });
  }, [recovery, queryClient]);

  useEffect(() => {
    setVisible(false);
    if (status === 'connected') return;
    const timer = window.setTimeout(() => setVisible(true), 1500);
    return () => window.clearTimeout(timer);
  }, [status]);

  if (!visible || status === 'connected') return null;
  return (
    <div className="weq-web-connection" role="status" aria-live="polite">
      <WifiOff size={18} aria-hidden />
      <span>{status === 'connecting' ? '正在连接电脑…' : '实时连接已断开，正在重连…'}</span>
    </div>
  );
}
