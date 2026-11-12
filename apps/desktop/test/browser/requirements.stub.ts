import { useState, useSyncExternalStore } from 'react';
const listeners = new Set<() => void>();
const values: Record<string, unknown> = { messageNotifications: false, applicationBadge: true };
let tick = 0;
export const PREFERENCES_CHANGED = 'test-preferences';
export const preferenceValue = (key: string) => values[key];
export function useClientPreferences() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => tick,
  );
}
export async function changePreference(key: string, value: unknown) {
  values[key] = value;
  tick++;
  for (const fn of listeners) fn();
  return true;
}
export const accountBinding = () => ({
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'fixture',
});
export const qa = { exports: [] as unknown[], remote: false };
Object.assign(window, { requirementsQa: qa });
export function useExportSavePolicy() {
  const [serverLocation, setServerLocation] = useState<{ name: string } | null>(null);
  const [resolve, setResolve] = useState<{ done(value: string | null): void } | null>(null);
  return {
    binding: accountBinding(),
    settings: { isLoading: false },
    isCurrent: () => true,
    serverLocation,
    chooseServerLocation: (directory: string | null) => {
      resolve?.done(directory);
      setServerLocation(null);
    },
    prepareSave: async () => {
      const directory = qa.remote
        ? '.'
        : await new Promise<string | null>((done) => {
            setResolve({ done });
            setServerLocation({ name: '选中的相册内容' });
          });
      return directory === null ? null : { mode: 'before' as const, directory };
    },
  };
}
const proxy = (path = ''): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      const next = `${path}.${String(key)}`;
      if (key === 'useQuery')
        return () => ({
          data: undefined,
          isLoading: false,
          refetch: async () => ({ data: undefined }),
        });
      if (key === 'mutate')
        return async (input: unknown) => {
          if (path.endsWith('.startAlbumReferenceExport')) qa.exports.push(input);
          return 'task-fixture';
        };
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      return proxy(next);
    },
  });
export const client = proxy();
export const trpc = proxy();
