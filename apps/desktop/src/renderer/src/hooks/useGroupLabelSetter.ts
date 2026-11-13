import { useQuery } from '@tanstack/react-query';
import { client } from '../trpc/client';
import { useQQWriteSession } from './useQQWriteSession';
import { PROFILE_QUERY_OPTIONS } from '../lib/profileQuery';

/** 仅浮层内挂载，账号及数据源隔离缓存；在线能力就绪后自动补全缺项。 */
export function useGroupLabelSetter(groupCode: string, uid: string, missing: boolean) {
  const session = useQQWriteSession(`group-label-setter:${groupCode}:${uid}`, true);
  return useQuery({
    queryKey: ['group-label-setter', session.binding, groupCode, uid, session.available],
    queryFn: () =>
      client.account.getGroupLabelSetter.query({
        ...session.binding!,
        groupCode,
        uid,
        online: session.available,
      }),
    enabled: missing && Boolean(session.binding) && /^u_[A-Za-z0-9_-]+$/.test(uid),
    ...PROFILE_QUERY_OPTIONS,
  });
}
