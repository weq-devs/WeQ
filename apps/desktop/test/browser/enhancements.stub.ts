import { useSyncExternalStore } from 'react';

const ids = ['text', 'voice', 'intent', 'dress'] as const;
const names = ['本地文字识别', '本地语音转写', '本地意图与画像', '装扮离线索引'];
const sizes = [63.45, 266.84, 693.12, 39.32];
const descriptions = [
  '图片文字识别与文字筛图',
  'SenseVoice 多语言转写与匹配引擎',
  '意图感知和互动画像共用的本地模型',
  'QQ 不在线时查询装扮地址，具体素材仍需联网获取',
];
let downloaded = new Set(['text', 'intent']);
const state = new URLSearchParams(location.search).get('state');
if (state === 'empty') downloaded = new Set();
if (state === 'installed') downloaded = new Set(ids);
let revision = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => {
  const packs = ids.map((id, index) => ({
    id,
    name: names[index],
    description: descriptions[index],
    downloaded: downloaded.has(id),
    ready: downloaded.has(id),
    installed: downloaded.has(id),
    busy: state === 'busy' && id === 'voice',
    blocker: null,
    downloadBytes: downloaded.has(id) ? 0 : sizes[index]! * 1048576,
    deleteBytes: sizes[index]! * 1048576,
    sizeOnDisk: downloaded.has(id) ? sizes[index]! * 1048576 : 0,
    operation:
      state === 'busy' && id === 'voice'
        ? {
            phase: 'downloading',
            total: sizes[index]! * 1048576,
            received: (sizes[index]! * 1048576) / 2,
            note: '正在下载',
          }
        : state === 'failed' && id === 'voice'
          ? { phase: 'failed', error: '网络连接中断' }
          : null,
  }));
  return {
    packs,
    all: {
      downloadBytes: packs.reduce((sum, pack) => sum + pack.downloadBytes, 0),
      sizeOnDisk: packs.reduce((sum, pack) => sum + pack.sizeOnDisk, 0),
    },
  };
};
const proxy = (path = ''): unknown =>
  new Proxy(() => undefined, {
    get(_target, key) {
      if (key === 'useUtils') return () => proxy('utils');
      if (key === 'useQuery')
        return () => {
          useSyncExternalStore(subscribe, () => revision);
          return {
            data:
              path === 'bootstrap.enhancementPacks'
                ? snapshot()
                : path === 'bootstrap.getSettings'
                  ? {
                      ocr: { onlineConcurrency: 5, prefilterEnabled: true },
                      voiceTranscribe: { onlineConcurrency: 5 },
                    }
                  : undefined,
            isLoading: false,
            isFetching: false,
            refetch: async () => {},
          };
        };
      if (key === 'invalidate')
        return async () => {
          revision++;
          for (const listener of listeners) listener();
        };
      if (key === 'useMutation')
        return () => ({
          isLoading: false,
          mutateAsync: async (input: { ids?: string[]; id?: string }) => {
            if (path === 'bootstrap.prepareEnhancementPacks')
              for (const id of input.ids ?? []) downloaded.add(id);
            if (path === 'bootstrap.deleteEnhancementPack') downloaded.delete(input.id!);
          },
        });
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
export const trpc = proxy();
export const client = proxy();
