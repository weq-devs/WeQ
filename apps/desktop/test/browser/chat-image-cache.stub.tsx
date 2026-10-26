import { useSyncExternalStore } from 'react';

let data = { chatImageCacheMiB: 128 };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const emit = () => {
  for (const listener of listeners) listener();
};
function useSettings() {
  const settings = useSyncExternalStore(subscribe, () => data);
  return { data: settings, isLoading: false, isFetching: false, isError: false };
}
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      if (key === 'useQuery')
        return path.at(-1) === 'getSettings' ? useSettings : () => ({ data: undefined });
      if (key === 'useMutation')
        return () => ({
          isLoading: false,
          mutateAsync: async ({ miB }: { miB: number }) => miB,
        });
      if (key === 'setData')
        return (_input: unknown, updater: (previous: typeof data) => typeof data) => {
          data = updater(data);
          emit();
        };
      if (key === 'invalidate') return async () => {};
      return proxy([...path, String(key)]);
    },
  });
export const trpc = proxy();
export const client = proxy();
