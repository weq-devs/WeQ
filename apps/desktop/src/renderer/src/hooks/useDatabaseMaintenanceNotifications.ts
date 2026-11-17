import { useEffect } from 'react';
import { client } from '../trpc/client';
import { useToast, useToastApi } from '../components/Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { databaseMaintenanceNotification } from '../lib/databaseMaintenanceNotification';
import { useDbRepairWindow } from '../state/dbRepairWindow';

const seen = new Set<string>();
const remember = (key: string) => {
  seen.add(key);
  if (seen.size > 1024) seen.delete(seen.values().next().value!);
};
export function useDatabaseMaintenanceNotifications(popup: Window | null): void {
  const { push } = useToastApi(null);
  useEffect(() => {
    const clear = () => {
      const state = useToast.getState();
      for (const toast of state.toasts)
        if (toast.key?.startsWith('database-maintenance')) state.remove(toast.id);
    };
    const focused = () => !!popup && !popup.closed && popup.document.hasFocus();
    popup?.addEventListener('focus', clear);
    if (focused()) clear();
    const maintenance = client.dbRepair.onMaintenance.subscribe(undefined, {
      onData(snapshot) {
        const notice = databaseMaintenanceNotification(snapshot);
        if (snapshot.operation?.kind === 'repair' && snapshot.operation.status !== 'running')
          useToast.getState().resolve(`database-maintenance-progress:${snapshot.id}`);
        if (focused()) {
          clear();
          if (notice && !notice.loading) remember(notice.key);
          return;
        }
        if (!notice || seen.has(notice.key)) return;
        if (!notice.loading) remember(notice.key);
        const { account, ...message } = notice;
        push({
          ...message,
          source: notificationSource(
            { kind: 'local', open: () => useDbRepairWindow.getState().open(account) },
            '查看数据库维护结果',
          ),
        });
      },
    });
    const health = client.bootstrap.onAccountForcedClosed.subscribe(undefined, {
      onData(event) {
        if (event.reason !== 'database-damaged') return;
        const notice = {
          event: 'databaseDamage' as const,
          key: `database-damage:${event.uin}:${event.configId ?? ''}`,
          tone: 'error' as const,
          title: event.title,
          detail: [event.message, ...event.details].join('\n'),
          source: notificationSource(
            {
              kind: 'local',
              open: () =>
                useDbRepairWindow.getState().open({
                  uin: event.uin,
                  configId: event.configId,
                  name: event.uin,
                  avatarUrl: '',
                  diagnostic: event,
                }),
            },
            '查看数据库检查结果',
          ),
        };
        push(notice);
      },
    });
    return () => {
      maintenance.unsubscribe();
      health.unsubscribe();
      popup?.removeEventListener('focus', clear);
    };
  }, [push, popup]);
}
