import { isQqProxyWaiting } from '../components/QqProxyConnection.shared';
import type { OnlineAccess } from '../lib/restrictedMode';
import { useViewState } from '../state/view';
import { trpc } from '../trpc/client';

export function useQqProxyStatus(poll: boolean, access: { data?: OnlineAccess; isError: boolean }) {
  const uin = useViewState((state) => (state.view === 'main' ? state.openedUin : null));
  const enabled = poll && Boolean(uin);
  const query = trpc.bootstrap.getQqClientSyncStatus.useQuery(undefined, {
    enabled,
    staleTime: 0,
    refetchInterval: enabled ? 5000 : false,
  });
  const data = query.data;
  const source = access.data?.source;
  const sourceConfigId =
    source?.expectedAccountUin === uin ? source.expectedAccountConfigId : undefined;
  const current =
    uin && data?.accountUin === uin && (!sourceConfigId || data.accountConfigId === sourceConfigId)
      ? data
      : undefined;
  const needsAttention = Boolean(
    current?.enabled && current.connectionExpected && !current.connected,
  );
  const waiting =
    needsAttention &&
    !query.isError &&
    !access.isError &&
    isQqProxyWaiting(current, access.data, uin);
  return { current, needsAttention, waiting, isError: query.isError, refetch: query.refetch };
}
