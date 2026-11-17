import { useSyncExternalStore } from 'react';

const ids = ['text', 'voice', 'intent', 'dress'] as const;
const names = ['本地文字识别', '本地语音转写', '本地意图与画像', '装扮离线索引'];
const sizes = [63.45, 266.84, 693.12, 39.32];
const descriptions = [
  '在本机识别图片文字，并跳过无文字图片。',
  '在本机将语音转为文字，支持中、英、日、韩、粤语。',
  '在本机分析消息意图、情绪与互动画像。',
  'QQ 不在线时也能查询装扮地址；下载具体素材仍需网络。',
];
let downloaded = new Set(['text', 'intent']);
let preferences = { autoCheck: true, autoInstall: false };
const state = new URLSearchParams(location.search).get('state');
const checking = state?.startsWith('checking') ?? false;
const partial = state === 'partial' || state === 'checking-partial';
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
    downloaded: downloaded.has(id) && !(partial && id === 'text'),
    ready: downloaded.has(id) && !(partial && id === 'text'),
    installed: downloaded.has(id),
    needsRepair: partial && id === 'text',
    missingComponents: partial && id === 'text' ? ['文字筛图模型'] : [],
    busy: (state === 'busy' || state === 'retrying') && id === 'voice',
    blocker: state === 'incompatible' && id === 'text' ? '需先更新 WeQ 至 v3.0.0' : null,
    requiresWeqUpdate: state === 'incompatible' && id === 'text',
    updateAvailable:
      ['update', 'partial', 'checking-update', 'checking-partial'].includes(state ?? '') &&
      id === 'text',
    check: { phase: checking ? 'checking' : 'unchecked' },
    sharedBytes: 0,
    downloadBytes:
      partial && id === 'text' ? 1048576 : downloaded.has(id) ? 0 : sizes[index]! * 1048576,
    deleteBytes: sizes[index]! * 1048576,
    sizeOnDisk: downloaded.has(id) ? sizes[index]! * 1048576 : 0,
    operation:
      (state === 'busy' || state === 'retrying') && id === 'voice'
        ? {
            phase: 'downloading',
            total: sizes[index]! * 1048576,
            received: (sizes[index]! * 1048576) / 2,
            note: '正在下载',
            source: 'github-proxy.memory-echoes.cn',
            attempt: 2,
            retryAt: state === 'retrying' ? Date.now() + 60000 : undefined,
          }
        : state === 'failed' && id === 'voice'
          ? { phase: 'failed', error: '网络连接中断' }
          : null,
  }));
  return {
    packs,
    preferences,
    all: {
      downloadBytes: packs.reduce((sum, pack) => sum + pack.downloadBytes, 0),
      sizeOnDisk: packs.reduce((sum, pack) => sum + pack.sizeOnDisk, 0),
    },
  };
};
const proxy = (path = ''): unknown =>
  new Proxy(() => undefined, {
    get(_target, key) {
      if (key === 'subscribe')
        return (_input: unknown, handler: { onData: (data: unknown) => void }) => {
          if (path === 'bootstrap.onEnhancementUpdates')
            handler.onData([
              { id: 'text', name: names[0], contentVersion: 'a'.repeat(64) },
              { id: 'voice', name: names[1], contentVersion: 'b'.repeat(64) },
            ]);
          return { unsubscribe: () => {} };
        };
      if (key === 'mutate' && path === 'bootstrap.acknowledgeEnhancementUpdates')
        return async () => true;
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
          isLoading:
            (checking || state === 'manual-check') && path === 'bootstrap.checkEnhancementUpdates',
          variables: { ids: ['text'] },
          mutateAsync: async (input: {
            ids?: string[];
            id?: string;
            autoCheck?: boolean;
            autoInstall?: boolean;
          }) => {
            if (path === 'bootstrap.prepareEnhancementPacks')
              for (const id of input.ids ?? []) downloaded.add(id);
            if (path === 'bootstrap.deleteEnhancementPack') downloaded.delete(input.id!);
            if (path === 'bootstrap.setEnhancementUpdates')
              preferences = { ...preferences, ...input };
          },
        });
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
export const trpc = proxy();
export const client = proxy();
