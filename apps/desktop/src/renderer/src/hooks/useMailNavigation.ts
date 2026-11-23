import { useEffect, useState } from 'react';
import { client, trpc } from '../trpc/client';

type OpenMail = (target: { kind: 'mail'; mailId: string; folderId: number }) => void;

export function useMailNavigation(selfUin: string | null, canQuery: boolean, openMail: OpenMail) {
  const preferences = trpc.settings.mail.get.useQuery(undefined, {
    enabled: Boolean(selfUin) && canQuery,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const [unread, setUnread] = useState<{
    uin: string;
    count: number;
    pending: boolean;
    enabled?: boolean;
  }>();
  useEffect(() => {
    if (!selfUin) return;
    const subscription = client.mail.events.subscribe(
      { selfUin },
      {
        onData: ({ type, status, notice }) => {
          if (type === 'open' && notice)
            openMail({ kind: 'mail', mailId: notice.id, folderId: notice.folderId });
          if (type !== 'status' || !status) return;
          const count = status.unread;
          const pending = status.unreadPending === true;
          const enabled = status.showUnread;
          setUnread((previous) =>
            previous?.uin === selfUin &&
            previous.count === count &&
            previous.pending === pending &&
            previous.enabled === enabled
              ? previous
              : { uin: selfUin, count, pending, enabled },
          );
        },
      },
    );
    return () => subscription.unsubscribe();
  }, [openMail, selfUin]);

  const saved = preferences.isFetchedAfterMount ? preferences.data?.showUnread : undefined;
  if (!unread || unread.uin !== selfUin || !(saved ?? unread.enabled))
    return { count: 0, pending: false };
  return { count: unread.count, pending: unread.pending };
}
