import type { Query, QueryClient } from '@tanstack/react-query';
import { useWebConnection } from '../state/webConnection';
import { remoteWorkspaceCheckPending, subscribeRemoteWorkspaceCheck } from './remoteWorkspaceCheck';

function canRecover() {
  return !remoteWorkspaceCheckPending() && document.visibilityState !== 'hidden';
}

function watchAvailability(listener: () => void) {
  const unsubscribe = subscribeRemoteWorkspaceCheck(listener);
  document.addEventListener('visibilitychange', listener);
  window.addEventListener('online', listener);
  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', listener);
    window.removeEventListener('online', listener);
  };
}

/** 同轮工作区验证和 WebSocket 重开共同交付，后台或验证中留到可读时。 */
export function subscribeWorkspaceRecovery(recover: (revision: number) => void) {
  let delivered = useWebConnection.getState().recovery;
  let queued = false;
  let stopped = false;
  const schedule = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const { recovery } = useWebConnection.getState();
      if (stopped || delivered === recovery || !canRecover()) return;
      delivered = recovery;
      recover(recovery);
    });
  };
  const unsubscribe = useWebConnection.subscribe((state, previous) => {
    if (state.recovery !== previous.recovery) schedule();
  });
  const stopAvailability = watchAvailability(schedule);
  return () => {
    stopped = true;
    unsubscribe();
    stopAvailability();
  };
}

const priorityReads = new Set([
  'startup.snapshot',
  'bootstrap.getSettings',
  'account.getAccountConfig',
  'clientState.snapshot',
  'clientState.accountSnapshot',
]);

function procedureName(query: Query): string {
  const path = query.queryKey[0];
  return Array.isArray(path) ? path.join('.') : '';
}

/** 目录由聊天层校准首批和可见行。其余活动读取按优先级补查并复用在途请求。 */
export function createWorkspaceQueryRecovery(client: QueryClient) {
  const cache = client.getQueryCache();
  const primary = new Map<string, Query>();
  const secondary = new Map<string, Query>();
  const running = new Set<string>();
  let primaryActive = 0;
  let secondaryActive = 0;
  let stopped = false;

  const pump = () => {
    if (stopped || !canRecover() || navigator.onLine === false) return;
    drain(primary, true);
    drain(secondary, false);
  };

  function drain(queue: Map<string, Query>, priority: boolean) {
    const active = () => (priority ? primaryActive : secondaryActive);
    const limit = priority ? 2 : 3;
    for (const [hash, query] of queue) {
      if (active() >= limit) break;
      if (running.has(hash)) continue;
      queue.delete(hash);
      if (
        cache.get(hash) !== query ||
        !query.isActive() ||
        !query.state.isInvalidated ||
        query.state.fetchStatus !== 'idle'
      )
        continue;
      running.add(hash);
      if (priority) primaryActive++;
      else secondaryActive++;
      void client
        .refetchQueries(
          { queryKey: query.queryKey, exact: true, type: 'active' },
          { cancelRefetch: false },
        )
        .catch(() => undefined)
        .finally(() => {
          running.delete(hash);
          if (priority) primaryActive--;
          else secondaryActive--;
          pump();
        });
    }
  }

  const stopAvailability = watchAvailability(pump);
  return {
    request() {
      if (stopped) return;
      primary.clear();
      secondary.clear();
      void client.invalidateQueries({ refetchType: 'none' });
      for (const query of cache.findAll({ type: 'active' })) {
        const path = procedureName(query);
        if (path === 'account.listRecentContacts') continue;
        const queue = priorityReads.has(path) ? primary : secondary;
        queue.set(query.queryHash, query);
      }
      pump();
    },
    dispose() {
      stopped = true;
      primary.clear();
      secondary.clear();
      stopAvailability();
    },
  };
}
