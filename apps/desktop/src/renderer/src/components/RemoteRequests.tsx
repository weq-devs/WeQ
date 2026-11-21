import { useEffect, useRef } from 'react';
import { trpc } from '../trpc/client';
import { IS_WEB } from '../lib/target.shared';
import { useDialog } from './Dialog.shared';
import { useToastApi } from './Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { notificationInlineText } from '../../../shared/notification_copy';

export function RemoteRequests() {
  return IS_WEB ? null : <DesktopRemoteRequests />;
}

function DesktopRemoteRequests() {
  const notificationToast = useToastApi();
  const status = trpc.remote.status.useQuery(undefined, {
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
    retry: false,
  });
  const decide = trpc.remote.decide.useMutation();
  const current = useDialog((state) => state.current);
  const active = useRef<string | null>(null);
  useEffect(() => {
    const pending = status.data?.pending;
    const tracked = active.current;
    if (tracked) {
      if (pending && !pending.some(({ id }) => id === tracked))
        notificationToast.resolve(`remote-request:${tracked}`);
      return;
    }
    const request = pending?.[0];
    if (!request || current) return;
    active.current = request.id;
    notificationToast.push({
      event: 'request',
      key: `remote-request:${request.id}`,
      title: `${notificationInlineText(request.name, 28) || '有一部手机'}请求连接 WeQ`,
      summary: '等待你确认是否允许连接',
      source: notificationSource(
        { kind: 'app', target: { kind: 'setting', section: 'remote' } },
        '查看连接请求',
        null,
      ),
    });
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
        notificationToast.push({
          tone: 'error',
          title: '未能处理手机连接请求',
          summary: '请让手机重新发起连接，再尝试确认',
          source: notificationSource(
            { kind: 'app', target: { kind: 'setting', section: 'remote' } },
            '查看 Remote 连接请求',
            null,
          ),
        });
      } finally {
        notificationToast.resolve(`remote-request:${request.id}`);
        await status.refetch();
        active.current = null;
      }
    })();
  }, [status.data, current, decide, status, notificationToast]);
  return null;
}
