import { useMemo } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useWorkspaceMenu } from '../state/workspaceMenu';

/** 两种联系人更新范围共用同一任务，手动重复触发只打开当前任务。 */
export function useContactRefreshTask() {
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: Boolean(uin) });
  const configId = config.data?.uin === uin ? config.data.configId : undefined;
  const binding = useMemo(
    () => ({ expectedAccountUin: uin ?? '', expectedAccountConfigId: configId ?? '' }),
    [uin, configId],
  );
  const ready = Boolean(uin && configId);
  const utils = trpc.useUtils();
  const snapshot = trpc.account.contactMetrics.status.useQuery(binding, {
    enabled: ready,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
    refetchInterval: (data) =>
      data?.progress.status === 'running' || data?.progress.status === 'paused' ? 1000 : false,
  });
  trpc.account.contactMetrics.changed.useSubscription(binding, {
    enabled: ready,
    onData: () => void utils.account.contactMetrics.status.invalidate(binding),
    onStarted: () => void utils.account.contactMetrics.status.invalidate(binding),
  });
  const active =
    ready &&
    (snapshot.data?.progress.status === 'running' || snapshot.data?.progress.status === 'paused');
  const openActiveTask = () => {
    if (!active || useViewState.getState().openedUin !== uin) return false;
    const menu = useWorkspaceMenu.getState();
    if (snapshot.data?.taskId) menu.focusTask(`background:host:${snapshot.data.taskId}`);
    else menu.openTasks();
    return true;
  };
  return { uin, binding, ready, snapshot, active, openActiveTask };
}
