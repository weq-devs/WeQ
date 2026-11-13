import { useEffect, useRef } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { useDialog } from '../components/Dialog';
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

  async function refresh() {
    if (!ready || openActiveTask() || rebuild.isLoading) return;
    const confirmed = await confirm(
      '更新全部群成员？',
      '将更新全部群的成员名单，完成后重新计算群交集。不更新群资料或好友信息，进度可在任务列表查看。',
      { okLabel: '更新并重新计算', cancelLabel: '取消', tone: 'info' },
    );
    if (!confirmed || useViewState.getState().openedUin !== uin) return;
    try {
      const taskId = await rebuild.mutateAsync({
        ...binding,
        target: 'groupMembers',
        range: 'all',
        missingOnly: false,
      });
      if (useViewState.getState().openedUin !== uin) return;
      void utils.account.contactMetrics.status.invalidate(binding);
      if (taskId) useWorkspaceMenu.getState().focusTask(`background:host:${taskId}`);
    } catch (error) {
      if (useViewState.getState().openedUin !== uin) return;
      showError('群成员更新启动失败', error instanceof Error ? error.message : String(error));
    }
  }
  return { refresh, refreshing, ready };
}
