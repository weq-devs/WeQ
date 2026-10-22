import { useEffect, useRef } from 'react';
import { trpc } from '../trpc/client';
import { IS_WEB } from '../lib/target';
import { useDialog } from './Dialog';
import { useToast } from './Toast';

export function RemoteRequests() {
  return IS_WEB ? null : <DesktopRemoteRequests />;
}

function DesktopRemoteRequests() {
  const status = trpc.remote.status.useQuery(undefined, {
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
    retry: false,
  });
  const decide = trpc.remote.decide.useMutation();
  const current = useDialog((state) => state.current);
  const active = useRef<string | null>(null);
  useEffect(() => {
    const request = status.data?.pending[0];
    if (!request || current || active.current) return;
    active.current = request.id;
    void (async () => {
      const approve = await useDialog
        .getState()
        .confirm(
          '手机请求连接 WeQ',
          `${request.name} · 校验码 ${request.code}。允许后可访问 WeQ Web（含聊天记录与操作），以后无需重新配对。`,
          { okLabel: '允许连接', cancelLabel: '拒绝' },
        );
      try {
        await decide.mutateAsync({ id: request.id, approve });
      } catch {
        useToast.getState().push({ tone: 'error', title: '连接请求已失效或无法保存，请重试' });
      } finally {
        await status.refetch();
        active.current = null;
      }
    })();
  }, [status.data, current, decide, status]);
  return null;
}
