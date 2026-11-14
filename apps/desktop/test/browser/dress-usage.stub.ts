import { useSyncExternalStore } from 'react';
import type { DressManifest } from '@weq/service';

const empty = new URLSearchParams(location.search).has('empty');
let manifest: DressManifest = {
  bubbles: [
    {
      itemId: 11,
      name: '浅绿聊天气泡',
      slice: { left: 4, right: 4, top: 4, bottom: 4 },
      imageSize: { w: 40, h: 40 },
      textColor: '#173c28',
      localFile: 'fixture.png',
    },
  ],
  fonts: [
    {
      itemId: 22,
      name: '中文与 English 示例字体',
      file: 'fixture.otf',
      deriveVersion: 1,
      fx: null,
    },
  ],
  widgets: [{ itemId: 33, name: '青色头像挂件', frameCount: 1, frameTimeMs: 100, repeat: 0 }],
  activeBubble: empty ? 0 : 11,
  activeFont: empty ? 0 : 22,
  activeWidget: empty ? 0 : 33,
  scope: 'mine',
  background: 'none',
  backgroundFile: '',
  widgetId: '',
  backgroundOpacity: 1,
};
let revision = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const own = { callBgId: 0, callBgName: '', callBgUrl: '' };
const snapshot = () => ({ manifest, qqOnline: true, own });
const proxy = (path = ''): unknown =>
  new Proxy(() => undefined, {
    get(_target, key) {
      if (key === 'useUtils') return () => proxy('utils');
      if (key === 'useQuery')
        return () => {
          useSyncExternalStore(subscribe, () => revision);
          return {
            data:
              path === 'account.dressup.getState'
                ? snapshot()
                : path === 'account.dressup.rank'
                  ? {
                      items: [
                        {
                          appId: 2,
                          itemId: 11,
                          name: '浅绿聊天气泡',
                          previewUrl: '',
                          previewLargeUrl: '',
                          labels: [],
                          price: 0,
                          mallName: '',
                        },
                      ],
                    }
                  : undefined,
            isLoading: false,
            isInitialLoading: false,
          };
        };
      if (key === 'invalidate')
        return async () => {
          revision++;
          for (const listener of listeners) listener();
        };
      if (key === 'useMutation')
        return () => ({
          mutateAsync: async (input: {
            scope?: DressManifest['scope'];
            kind?: string;
            itemId?: number;
          }) => {
            if (path === 'account.dressup.setScope' && input.scope)
              manifest = { ...manifest, scope: input.scope };
            if (path === 'account.dressup.setActive')
              manifest = {
                ...manifest,
                [input.kind === 'bubble'
                  ? 'activeBubble'
                  : input.kind === 'font'
                    ? 'activeFont'
                    : 'activeWidget']: input.itemId ?? 0,
              };
            return manifest;
          },
        });
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
export const trpc = proxy();
export const client = proxy();
