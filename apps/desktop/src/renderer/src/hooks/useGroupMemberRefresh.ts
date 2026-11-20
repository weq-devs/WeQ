import { useEffect, useRef, useState } from 'react';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useDialog } from '../components/Dialog.shared';
import { useContactRefreshTask } from './useContactRefreshTask';

/** 群交集与联系人共用同一刷新任务，只选择群成员名单范围。 */
export function useGroupMemberRefresh() {
  const { uin, binding, ready, snapshot, active, openActiveTask } = useContactRefreshTask();
  const utils = trpc.useUtils();
  const appliedGraph = useRef('');
  const graphRevision = snapshot.data?.relationGraphRevision ?? 0;
  useEffect(() => {
    if (!ready || !graphRevision) return;
    const key = JSON.stringify([binding, graphRevision]);
    if (appliedGraph.current === key) return;
    appliedGraph.current = key;
    void utils.account.getRelationGraph.invalidate();
  }, [ready, binding, graphRevision, utils]);
  const rebuild = trpc.account.contactMetrics.rebuild.useMutation();
  const showError = useDialog((state) => state.showError);
  const confirm = useDialog((state) => state.confirm);
  const refreshing = rebuild.isLoading || active;
  const task =
    snapshot.data?.target === 'groupMembers' && snapshot.data.taskId ? snapshot.data : null;
  const acting = useRef(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!ready || rebuild.isLoading || (active && task?.foreground) || openActiveTask()) return;
    const confirmed = await confirm(
      '更新全部群成员？',
      '将更新全部群的成员名单，完成后重新计算群交集。不更新群资料或好友信息，进度保留在群交集页面。',
      { okLabel: '更新并重新计算', cancelLabel: '取消', tone: 'info' },
    );
    if (!confirmed || useViewState.getState().openedUin !== uin) return;
    try {
      await rebuild.mutateAsync({
        ...binding,
        target: 'groupMembers',
        range: 'all',
        missingOnly: false,
        foreground: true,
      });
      if (useViewState.getState().openedUin !== uin) return;
      void utils.account.contactMetrics.status.invalidate(binding);
    } catch (error) {
      if (useViewState.getState().openedUin !== uin) return;
      showError('群成员更新启动失败', error instanceof Error ? error.message : String(error));
    }
  }
  async function control(action: string) {
    if (!ready || !task?.taskId || acting.current || useViewState.getState().openedUin !== uin)
      return;
    acting.current = true;
    setBusy(true);
    try {
      if (action === 'background')
        await client.account.contactMetrics.backgroundRefresh.mutate({
          ...binding,
          taskId: task.taskId,
        });
      else
        await client.backgroundTasks.act.mutate({
          id: task.taskId,
          action,
          scope: { uin: binding.expectedAccountUin, configId: binding.expectedAccountConfigId },
        });
      await utils.account.contactMetrics.status.invalidate(binding);
    } catch (reason) {
      if (useViewState.getState().openedUin === uin)
        showError('群成员更新操作失败', reason instanceof Error ? reason.message : String(reason));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }
  return { refresh, refreshing, ready, task, busy, control };
}
