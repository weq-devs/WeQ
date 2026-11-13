import { useQuery } from '@tanstack/react-query';
import { client } from '../trpc/client';
import { useQQWriteSession } from './useQQWriteSession';
import { PROFILE_QUERY_OPTIONS } from './useContactCard';

/** 名片先显示本地资料；云端投影按账号缓存，不写入会话名称。 */
export function useCardDisplayNames(kind: 'user' | 'group', target: string, enabled = true) {
  const session = useQQWriteSession(`card-names:${kind}:${target}`, true);
  const query = useQuery({
    queryKey: ['contact-cloud-name', session.binding, kind, target],
    queryFn: () => client.account.getCardDisplayNames.query({ kind, target, ...session.binding }),
    enabled: enabled && session.available && /^[1-9]\d{0,9}$/.test(target),
    ...PROFILE_QUERY_OPTIONS,
  });
  return query.data;
}
