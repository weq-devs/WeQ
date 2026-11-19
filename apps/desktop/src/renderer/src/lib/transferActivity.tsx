import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { client } from '../trpc/client';
import type { ActiveTransfer, TransferProgress } from '../../../shared/transfer_progress';

type Binding = { expectedAccountUin: string; expectedAccountConfigId: string };

function equal(a: TransferProgress | undefined, b: TransferProgress) {
  return (
    a?.phase === b.phase &&
    a.received === b.received &&
    a.total === b.total &&
    a.processed === b.processed &&
    a.items === b.items
  );
}

export class TransferActivity {
  private received = new Map<string, TransferProgress>();
  private local = new Map<string, TransferProgress>();
  private listeners = new Map<string, Set<() => void>>();

  subscribe(key: string, listener: () => void) {
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }

  get(key: string) {
    return this.received.get(key) ?? this.local.get(key);
  }

  replace(snapshot: ActiveTransfer[]) {
    const next = new Map<string, TransferProgress>();
    const add = (key: string, entry: TransferProgress) => {
      const previous = this.received.get(key);
      next.set(key, equal(previous, entry) ? previous! : entry);
    };
    for (const entry of snapshot) {
      add(entry.id, entry);
      if (entry.target && entry.id !== entry.target) add(entry.target, entry);
    }
    const previous = this.received;
    this.received = next;
    for (const [key, listeners] of this.listeners)
      if (previous.get(key) !== next.get(key)) for (const listener of listeners) listener();
  }

  setLocal(id: string, progress?: TransferProgress) {
    if (progress) this.local.set(id, progress);
    else this.local.delete(id);
    for (const listener of this.listeners.get(id) ?? []) listener();
  }
}

const ActivityContext = createContext<TransferActivity | null>(null);
const noSubscription = () => () => {};

export function TransferActivityProvider({
  binding,
  children,
}: {
  binding: Binding | null;
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
  return <ActivityContext.Provider value={activity}>{children}</ActivityContext.Provider>;
}

export const useTransferActivity = () => useContext(ActivityContext);

function useTransferValue<T>(
  key: string | undefined,
  select: (progress: TransferProgress | undefined) => T,
) {
  const activity = useTransferActivity();
  const read = useCallback(
    () => select(key ? activity?.get(key) : undefined),
    [activity, key, select],
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      key && activity ? activity.subscribe(key, listener) : noSubscription(),
    [activity, key],
  );
  return useSyncExternalStore(subscribe, read, read);
}

const identity = (progress: TransferProgress | undefined) => progress;
export const useTransferProgress = (key?: string) => useTransferValue(key, identity);
export const useTransferActive = (key?: string) => useTransferValue(key, Boolean);
