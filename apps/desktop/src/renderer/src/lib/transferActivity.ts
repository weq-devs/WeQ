import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import {
  transferPercent,
  type ActiveTransfer,
  type TransferProgress,
} from '../../../shared/transfer_progress';
import type { BackgroundTask } from '../../../shared/background_task';
import {
  exportTransferReadout,
  outgoingTransferProgress,
  transferDetail,
  transferLabel,
} from './transferPresentation';

function equal(a: TransferProgress | undefined, b: TransferProgress) {
  return (
    a?.phase === b.phase &&
    a.received === b.received &&
    a.total === b.total &&
    a.processed === b.processed &&
    a.items === b.items &&
    a.itemTransfer === b.itemTransfer &&
    a.paused === b.paused
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

export const TransferActivityContext = createContext<TransferActivity | null>(null);
const noSubscription = () => () => {};

export const useTransferActivity = () => useContext(TransferActivityContext);

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

export function useExportTransferProgress(id?: string) {
  const progress = useTransferProgress(id);
  return progress ? exportTransferReadout(progress) : undefined;
}

export function useOutgoingTaskProgress(
  task: Pick<BackgroundTask, 'outgoingTransfer' | 'statusLabel'>,
) {
  const transfer = useTransferProgress(task.outgoingTransfer?.id);
  if (!task.outgoingTransfer || task.statusLabel) return undefined;
  const progress = outgoingTransferProgress(transfer, task.outgoingTransfer.toHost) ?? {
    phase: 'preparing',
  };
  const percent = transferPercent(progress);
  return {
    label: transferLabel(progress),
    percent,
    counts: percent === undefined ? transferDetail(progress) : undefined,
  };
}
