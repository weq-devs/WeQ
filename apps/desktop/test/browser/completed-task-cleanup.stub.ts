import { useSyncExternalStore } from 'react';
import { rpcFixture } from './trpc.stub';
import type { TaskArchive, TaskArchiveEntry } from '../../src/shared/task_archive';

export { trpc } from './trpc.stub';

let entries: TaskArchive = {
  'export:archived': { result: 'completed::', archivedAt: 1 },
};
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function changeEntries(patch: Record<string, TaskArchiveEntry>) {
  entries = { ...entries, ...patch };
  for (const listener of listeners) listener();
}
export const useArchiveFixture = () => ({
  data: useSyncExternalStore(subscribe, () => entries),
});
rpcFixture.set('taskArchive.list.useQuery', useArchiveFixture);

export const taskArchiveFixture = {
  change: {
    mutate: async ({
      action,
      tasks,
    }: {
      action: string;
      tasks: { id: string; result: string }[];
    }) => {
      changeEntries(
        Object.fromEntries(
          tasks.map(({ id, result }) => [
            id,
            { result, archivedAt: action === 'restore' ? undefined : Date.now() },
          ]),
        ),
      );
      return { changed: tasks.length };
    },
  },
  remove: { mutate: async () => true },
};
export const client = { taskArchive: taskArchiveFixture };
