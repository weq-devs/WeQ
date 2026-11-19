import { useEffect, useState, type ReactNode } from 'react';
import { TransferActivity, TransferActivityContext } from '../lib/transferActivity';
import { client } from '../trpc/client';

export function TransferActivityProvider({
  binding,
  children,
}: {
  binding: { expectedAccountUin: string; expectedAccountConfigId: string } | null;
  children?: ReactNode;
}) {
  const [activity] = useState(() => new TransferActivity());
  const uin = binding?.expectedAccountUin;
  const configId = binding?.expectedAccountConfigId;
  useEffect(() => {
    if (!uin || !configId) return;
    let active = true;
    const subscription = client.account.transfers.watch.subscribe(
      { expectedAccountUin: uin, expectedAccountConfigId: configId },
      {
        onData: (data) => {
          if (active) activity.replace(data);
        },
        onError: () => {
          if (active) activity.replace([]);
        },
      },
    );
    return () => {
      active = false;
      subscription.unsubscribe();
      activity.replace([]);
    };
  }, [activity, uin, configId]);
  return (
    <TransferActivityContext.Provider value={activity}>{children}</TransferActivityContext.Provider>
  );
}
