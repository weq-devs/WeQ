import { useSyncExternalStore } from 'react';

type Permissions = { role: 'member' | 'admin' | 'owner'; muteAll: boolean; muteUntil: number };
let permissions: Permissions = { role: 'member', muteAll: true, muteUntil: 0 };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const muteQA = {
  set(value: Partial<Permissions>) {
    permissions = { ...permissions, ...value };
    for (const listener of listeners) listener();
  },
};
const proxy = (path = ''): unknown => {
  function useQuery() {
    const current = useSyncExternalStore(subscribe, () => permissions);
    return {
      data: path.endsWith('.groupPermissions')
        ? current
        : path.endsWith('.getAccountConfig')
          ? { uin: '26113', configId: 'fixture' }
          : undefined,
      isLoading: false,
      isFetching: false,
    };
  }
  return new Proxy(() => proxy(path), {
    get: (_target, key) =>
      key === 'useQuery'
        ? useQuery
        : key === 'useMutation'
          ? () => ({ mutate() {}, mutateAsync: async () => undefined, isLoading: false })
          : ['query', 'fetch', 'invalidate'].includes(String(key))
            ? async () => undefined
            : proxy(`${path}.${String(key)}`),
  });
};
export const trpc = proxy();
export const client = proxy();
