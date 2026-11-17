import { useEffect } from 'react';
import { client } from '../trpc/client';
import { useToastApi } from '../components/Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { databaseMaintenanceNotification } from '../lib/databaseMaintenanceNotification';
import { useDbRepairWindow } from '../state/dbRepairWindow';

const seen = new Set<string>();
export function useDatabaseMaintenanceNotifications(): void {
  const { push } = useToastApi(null);
  useEffect(() => {
    const maintenance = client.dbRepair.onMaintenance.subscribe(undefined, {
      onData(snapshot) {
        const notice = databaseMaintenanceNotification(snapshot);
        if (!notice || seen.has(notice.key)) return;
        seen.add(notice.key);
        if (seen.size > 1024) seen.delete(seen.values().next().value!);
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
    };
  }, [push]);
}
