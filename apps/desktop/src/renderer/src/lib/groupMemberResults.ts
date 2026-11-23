import { reconcileResolvedRows } from './resolvedRows';

/** Chat and directory previews share display results, while their read schedules stay independent. */
export function createGroupMemberResults<T extends { uid: string }>(
  inactiveGroups = 128,
  inactiveRows = 6000,
) {
  const recency = new Map<string, number>();
  let pinned = new Set<string>();
  let snapshot: Record<string, Record<string, T>> = {};
  const listeners = new Set<() => void>();
  const evictions = new Set<(group: string) => void>();

  function trim() {
    let rows = 0;
    let groups = 0;
    for (const [group, count] of recency) {
      if (pinned.has(group)) continue;
      groups++;
      rows += count;
    }
    let next = snapshot;
    for (const [group, count] of recency) {
      if (rows <= inactiveRows && groups <= inactiveGroups) break;
      if (pinned.has(group)) continue;
      recency.delete(group);
      rows -= count;
      groups--;
      if (Object.hasOwn(next, group)) {
        if (next === snapshot) next = { ...snapshot };
        delete next[group];
      }
      for (const evict of evictions) evict(group);
    }
    snapshot = next;
  }

  function touch(group: string, count = recency.get(group) ?? 0) {
    recency.delete(group);
    recency.set(group, count);
  }

  function publish(previous: typeof snapshot) {
    trim();
    if (snapshot !== previous) for (const notify of listeners) notify();
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onEvict(listener: (group: string) => void) {
      evictions.add(listener);
      return () => {
        evictions.delete(listener);
      };
    },
    protect(groups: Iterable<string>) {
      pinned = new Set(groups);
      publish(snapshot);
    },
    touch(group: string) {
      const alreadyTracked = recency.has(group);
      touch(group);
      if (!alreadyTracked) publish(snapshot);
    },
    merge(group: string, members: readonly T[], accept?: (member: T) => boolean) {
      if (!recency.has(group)) return;
      const previous = snapshot;
      const current = Object.hasOwn(snapshot, group) ? snapshot[group]! : {};
      const next = reconcileResolvedRows(current, members, accept);
      if (current === next) return;
      snapshot = { ...snapshot, [group]: next };
      touch(group, Object.keys(next).length);
      publish(previous);
    },
  };
}

export type GroupMemberResults<T extends { uid: string }> = ReturnType<
  typeof createGroupMemberResults<T>
>;
