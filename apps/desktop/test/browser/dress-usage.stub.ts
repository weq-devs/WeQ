import { useSyncExternalStore } from 'react';
import type {
  DressConversationEntry,
  DressMallItem,
  DressManifest,
  DressScopeKind,
} from '@weq/service';

const empty = new URLSearchParams(location.search).has('empty');
const dressTools = new URLSearchParams(location.search).has('tools');
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
  background: new URLSearchParams(location.search).has('backdrop') ? 'qq' : 'none',
  backgroundFile: '',
  widgetId: '',
  backgroundOpacity: 1,
  widgetOpacity: 1,
};
let revision = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const own = {
  callBgId: 0,
  callBgName: '',
  callBgUrl: '',
  chatBgUrl: 'https://example.test/background.png',
};
let conversationOverrides: Record<string, DressConversationEntry> = new URLSearchParams(
  location.search,
).has('exceptions')
  ? { 'group:42': { kind: 'group', conv: '42', title: '项目讨论', background: 'off' } }
  : {};
if (new URLSearchParams(location.search).has('picker'))
  conversationOverrides['c2c:u_preview'] = {
    kind: 'c2c',
    conv: 'u_preview',
    title: '预览会话',
    callbg: 'off',
  };
const callBackgrounds: DressMallItem[] = Array.from({ length: 60 }, (_, index) => ({
  appId: 17,
  itemId: index + 1,
  name: `通话背景 ${index + 1}`,
  previewUrl: 'https://example.test/portrait.png',
  previewLargeUrl: '',
  labels: [],
  price: 0,
  mallName: '',
}));
const screenWidgets = ['1', '3', '4', '6', '7', '8', '10', '11', '2016'].map((id) => ({ id }));
const snapshot = () => ({ manifest, qqOnline: true, own, conversationOverrides });
function refresh() {
  revision++;
  for (const listener of listeners) listener();
}
const proxy = (path = ''): unknown =>
  new Proxy(() => undefined, {
    get(_target, key) {
      if (key === 'useUtils') return () => proxy('utils');
      if (key === 'useQuery')
        return (input?: { kind?: string }) => {
          useSyncExternalStore(subscribe, () => revision);
          return {
            data:
              path === 'bootstrap.getDevelopmentFeatures'
                ? { dressTools }
                : path === 'account.dressup.getState'
                  ? snapshot()
                  : path === 'account.dressup.rank'
                    ? input?.kind === 'callbg'
                      ? { items: callBackgrounds }
                      : {
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
                    : path === 'account.dressup.widgets'
                      ? screenWidgets
                      : undefined,
            isLoading: false,
            isInitialLoading: false,
          };
        };
      if (key === 'invalidate') return async () => refresh();
      if (key === 'setData') return () => refresh();
      if (key === 'useMutation')
        return () => ({
          mutateAsync: async (input: {
            scope?: DressManifest['scope'];
            kind?: DressScopeKind | 'group';
            conv?: string;
            itemId?: number;
            value?: null;
          }) => {
            if (path === 'account.dressup.setScope' && input.scope && input.kind)
              manifest = {
                ...manifest,
                scopes: {
                  bubble: 'mine',
                  font: 'mine',
                  widget: 'mine',
                  ...manifest.scopes,
                  [input.kind]: input.scope,
                },
              };
            if (path === 'account.dressup.setConversationOverride' && input.value === null) {
              conversationOverrides = { ...conversationOverrides };
              delete conversationOverrides[`${input.kind}:${input.conv}`];
              return conversationOverrides;
            }
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
