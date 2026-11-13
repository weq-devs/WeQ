import { useSyncExternalStore } from 'react';

let enabled = true;
let revision = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const data = (path: string) => {
  if (path === 'bootstrap.getSettings')
    return { ocr: { prefilterEnabled: enabled, onlineConcurrency: 5 } };
  if (path === 'bootstrap.localModelResources')
    return {
      engineBlocker: null,
      ocr: ['ocr', 'filter'].map((kind) => ({
        id: kind,
        kind,
        name: kind === 'ocr' ? 'PP-OCRv5 mobile' : 'PP-OCRv6 det tiny',
        desc: kind === 'ocr' ? '本地文字识别模型' : '轻量文字检测模型',
        sizeLabel: '1.7 MB',
        sizeOnDisk: 1782579,
        downloaded: true,
        recommended: true,
      })),
    };
  return undefined;
};
const proxy = (path = ''): unknown =>
  new Proxy(() => undefined, {
    get(_target, key) {
      if (key === 'useUtils') return () => proxy('utils');
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      if (key === 'invalidate')
        return async () => {
          revision++;
          for (const listener of listeners) listener();
        };
      if (key === 'useQuery')
        return () => {
          useSyncExternalStore(subscribe, () => revision);
          return {
            data: data(path),
            isLoading: false,
            isFetching: false,
            refetch: async () => ({ data: data(path) }),
          };
        };
      if (key === 'useMutation')
        return () => ({
          isLoading: false,
          mutateAsync: async (input: { enabled: boolean }) => {
            if (path === 'bootstrap.setOcrPrefilterEnabled') enabled = input.enabled;
          },
        });
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
export const trpc = proxy();
export const client = proxy();
