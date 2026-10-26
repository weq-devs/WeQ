import { useEffect, useSyncExternalStore } from 'react';
import { useViewState } from '../state/view';
import { trpc } from '../trpc/client';
import { getCloneTasks, subscribeCloneTasks } from '../views/agentlab/cloneTaskStore';

/** 由主界面订阅完成态，切出克隆工作区后仍刷新会话目录。 */
export function useCloneTaskRefresh(): void {
  const accountId = useViewState((state) => state.openedUin);
  const utils = trpc.useUtils();
  const doneTaskIds = useSyncExternalStore(subscribeCloneTasks, () =>
    JSON.stringify(
      getCloneTasks()
        .filter((task) => task.accountId === accountId && task.status === 'done')
        .map((task) => [task.personaId, task.revision]),
    ),
  );
  useEffect(() => {
    if (accountId && doneTaskIds !== '[]') {
      void utils.account.listAgentLabPersonas.invalidate();
      void utils.account.getAgentLabPersonaDetail.invalidate();
      void utils.account.getAgentLabPersona.invalidate();
    }
  }, [accountId, doneTaskIds, utils]);
}
