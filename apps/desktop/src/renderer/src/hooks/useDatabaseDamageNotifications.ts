import { useEffect } from 'react';
import { client } from '../trpc/client';
import { useToastApi } from '../components/Toast.shared';
import type { DatabaseDamagedEvent } from '../components/DatabaseDamagedDialog';
import { notificationSource } from '../lib/notificationNavigation.shared';

export function useDatabaseDamageNotifications(
  openDetails: (event: DatabaseDamagedEvent) => void,
): void {
  const { push } = useToastApi(null);
  useEffect(() => {
    const sub = client.bootstrap.onAccountForcedClosed.subscribe(undefined, {
      onData(event) {
        if (event?.reason !== 'database-damaged') return;
        push({
          event: 'databaseDamage',
          key: `database-damage:${event.uin}`,
          tone: 'error',
          title: event.title,
          detail: [
            event.message,
            ...event.details,
            event.reportPath ? `检查报告：${event.reportPath}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          source: notificationSource(
            { kind: 'local', open: () => openDetails(event) },
            '查看检查详情',
          ),
        });
      },
      onError(error) {
        console.error('[account] onAccountForcedClosed subscription error', error);
      },
    });
    return () => sub.unsubscribe();
  }, [openDetails, push]);
}
