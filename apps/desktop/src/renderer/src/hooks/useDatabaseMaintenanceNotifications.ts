import { useEffect, useRef } from 'react';
import { verifiedDatabaseScans } from '@weq/service/db-checkup';
import { client } from '../trpc/client';
import { useToast } from '../components/Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { databaseMaintenanceNotification } from '../lib/databaseMaintenanceNotification';
import { useDbRepairWindow } from '../state/dbRepairWindow';

type MaintenanceNotice = NonNullable<ReturnType<typeof databaseMaintenanceNotification>>;

const seen = new Set<string>();
const remember = (key: string) => {
  seen.add(key);
  if (seen.size > 1024) seen.delete(seen.values().next().value!);
};
function damageToastKey(uin: string, configId: string | undefined, dbPath: string): string {
  return `database-damage:${JSON.stringify([uin, configId, dbPath])}`;
}

export function useDatabaseMaintenanceNotifications(popup: Window | null): void {
  const binding = useToast((state) => state.account);
  const activeProgress = useRef(new Map<string, MaintenanceNotice>());
  useEffect(() => {
    activeProgress.current.clear();
  }, [binding]);
  useEffect(() => {
    if (!binding) return;
    const progress = activeProgress.current;
    const matches = ({ uin, configId }: { uin: string; configId?: string }) =>
      useToast.getState().account === binding &&
      uin === binding.expectedAccountUin &&
      (!configId || configId === binding.expectedAccountConfigId);
    const pushNotice = ({ account, ...message }: MaintenanceNotice) => {
      if (!matches(account)) return;
      useToast.getState().push({
        ...message,
        account: binding,
        source: notificationSource(
          { kind: 'local', open: () => useDbRepairWindow.getState().open(account) },
          account.checkupResult ? '查看数据库体检结果' : '查看数据库维护结果',
          binding,
        ),
      });
    };
    const clear = () => {
      const state = useToast.getState();
      if (state.account !== binding) return;
      for (const key of progress.keys()) state.resolve(key);
      for (const toast of state.toasts)
        if (toast.key?.startsWith('database-maintenance')) state.remove(toast.id);
    };
    const focused = () => !!popup && !popup.closed && popup.document.hasFocus();
    const showProgress = () => {
      if (!focused()) for (const notice of progress.values()) pushNotice(notice);
    };
    popup?.addEventListener('focus', clear);
    popup?.addEventListener('blur', showProgress);
    if (focused()) clear();
    else showProgress();
    const maintenance = client.dbRepair.onMaintenance.subscribe(undefined, {
      onData(snapshot) {
        if (!matches(snapshot)) return;
        for (const scan of verifiedDatabaseScans(snapshot))
          useToast.getState().resolve(damageToastKey(snapshot.uin, snapshot.configId, scan.dbPath));
        const notice = databaseMaintenanceNotification(snapshot);
        const progressKey = `database-maintenance-progress:${snapshot.id}`;
        if (notice?.loading) progress.set(notice.key, notice);
        else if (progress.delete(progressKey) || snapshot.operation?.kind === 'repair')
          useToast.getState().resolve(progressKey);
        if (focused()) {
          clear();
          if (notice && !notice.loading) remember(notice.key);
          return;
        }
        if (!notice || seen.has(notice.key)) return;
        if (!notice.loading) remember(notice.key);
        pushNotice(notice);
      },
    });
    const health = client.bootstrap.onAccountForcedClosed.subscribe(undefined, {
      onData(event) {
        if (event.reason !== 'database-damaged' || event.kind !== 'confirmed' || !matches(event))
          return;
        const failure = event.failures[0];
        if (!failure) return;
        const notice = {
          event: 'databaseDamage' as const,
          key: damageToastKey(event.uin, event.configId, failure.dbPath),
          tone: 'error' as const,
          title: event.title,
          summary: event.message,
          detail: event.details.join('\n'),
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
            binding,
          ),
        };
        useToast.getState().push(notice);
      },
    });
    return () => {
      maintenance.unsubscribe();
      health.unsubscribe();
      popup?.removeEventListener('focus', clear);
      popup?.removeEventListener('blur', showProgress);
    };
  }, [binding, popup]);
}
