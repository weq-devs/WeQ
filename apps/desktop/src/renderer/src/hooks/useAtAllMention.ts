import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { atAllMentionState } from '../lib/atAllMention';

/** 仅在候选展开时读取，不轮询，不把其他账号／配置的旧额度当成可用。 */
export function useAtAllMention(active: boolean, groupId: number) {
  const uin = useViewState((state) => state.openedUin);
  const enabled = active && Boolean(uin) && Number.isSafeInteger(groupId) && groupId > 0;
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled,
    staleTime: 0,
    retry: false,
  });
  const access = trpc.account.getGroupAlbumAccessState.useQuery(undefined, {
    enabled,
    staleTime: 0,
    retry: false,
  });
  const source = config.data?.uin === uin && config.data?.configId ? config.data : null;
  const online = Boolean(
    source &&
      access.data?.qqOnline &&
      access.data.attachEnabled &&
      access.data.hasA2 &&
      access.data.hasD2 &&
      access.data.hasD2Key &&
      access.data.hasGuid,
  );
  const query = trpc.account.qqActions.atAllMention.useQuery(
    {
      expectedAccountUin: uin ?? '',
      expectedAccountConfigId: source?.configId ?? '',
      groupId,
    },
    {
      enabled: enabled && online,
      retry: false,
      staleTime: 0,
      cacheTime: 0,
    },
  );
  return atAllMentionState({
    online: enabled && online,
    loading:
      enabled &&
      ((!config.data && config.isFetching) ||
        (!access.data && access.isFetching) ||
        (online && query.isFetching)),
    error: Boolean(config.error || access.error || query.error),
    data: enabled && source && !query.isFetching ? query.data : undefined,
  });
}
