import { useSyncExternalStore } from 'react';
import type { SettingsResetTarget, SettingsResetItem } from '../../src/shared/settings_reset';
import { DEFAULT_CONTACT_CARD } from '@weq/service/contact-card';
import { preferenceDefaults } from '@weq/service/client-preferences';
const listeners = new Set<() => void>();
const DEFAULT_QZONE_PAGINATION = { windowSeconds: 10, maxPages: 5 };
let version = 0;
const notify = () => {
  version++;
  listeners.forEach((listener) => {
    listener();
  });
};
export const state = {
  preferences: structuredClone(preferenceDefaults),
  settings: {
    qzonePagination: { ...DEFAULT_QZONE_PAGINATION },
    contactCard: {
      ...structuredClone(DEFAULT_CONTACT_CARD),
      visible: Object.fromEntries(
        Object.keys(DEFAULT_CONTACT_CARD.visible).map((key) => [key, true]),
      ),
    },
    callRecording: {
      mode: 'mixed',
      systemAudio: false,
      udpTrace: false,
      dir: '/synthetic/recordings',
    },
  },
  calls: [] as Array<{ path: string; input: unknown }>,
  delay: 0,
  fail: false,
};
function items(target: SettingsResetTarget): SettingsResetItem[] {
  if (target.page === 'contact-card')
    return [
      {
        id: 'contact-card:contactCard',
        label: '名片显示与顺序',
        scope: '全局',
        current: state.settings.contactCard,
        defaultValue: DEFAULT_CONTACT_CARD,
      },
    ];
  if (target.page === 'qzone')
    return [
      {
        id: 'qzone-pagination:qzonePagination',
        label: '在线翻页限速',
        scope: '全局',
        current: state.settings.qzonePagination,
        defaultValue: DEFAULT_QZONE_PAGINATION,
      },
    ];
  if (target.page === 'call-recording')
    return [
      {
        id: 'call-directory:dir',
        label: '通话录音目录',
        scope: '全局',
        current: state.settings.callRecording.dir,
        defaultValue: null,
        directory: true,
      },
    ];
  return [];
}
async function mutate(path: string, input: unknown) {
  state.calls.push({ path, input });
  if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
  if (state.fail) throw new Error('合成写入失败');
  if (path === 'clientState.patch') {
    Object.assign(state.preferences, input);
    notify();
    return { revision: version, values: state.preferences, records: {} };
  }
  if (path === 'bootstrap.setQzonePagination')
    state.settings.qzonePagination = input as typeof state.settings.qzonePagination;
  if (path === 'bootstrap.setCallRecording') Object.assign(state.settings.callRecording, input);
  if (path === 'settingsReset.restore') {
    const value = input as SettingsResetTarget & { directories: string[] };
    const selected = items(value).filter(
      (item) => !item.directory || value.directories.includes(item.id),
    );
    if (value.page === 'qzone') state.settings.qzonePagination = { ...DEFAULT_QZONE_PAGINATION };
    if (value.page === 'call-recording' && selected.length) state.settings.callRecording.dir = '';
    notify();
    return selected.map((item) => ({ id: item.id, ok: true }));
  }
  notify();
  return state.settings;
}
function query(path: string, input?: unknown) {
  if (path === 'bootstrap.getSettings') return state.settings;
  if (path === 'settingsReset.preview')
    return { source: null, items: items(input as SettingsResetTarget) };
  return undefined;
}
const proxy = (path = ''): unknown =>
  new Proxy(() => undefined, {
    get(_target, key) {
      if (key === 'useUtils') return () => proxy('utils');
      if (key === 'invalidate')
        return async () => {
          notify();
        };
      if (key === 'useQuery')
        return (input: unknown) => {
          useSyncExternalStore(
            (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
            () => version,
          );
          return {
            data: query(path, input),
            isLoading: false,
            isFetching: false,
            refetch: async () => {
              notify();
              return { data: query(path, input) };
            },
          };
        };
      if (key === 'useMutation')
        return () => ({
          mutateAsync: (input: unknown) => mutate(path, input),
          mutate: (input: unknown) => void mutate(path, input),
          isLoading: false,
        });
      if (key === 'query') return async (input: unknown) => query(path, input);
      if (key === 'mutate') return (input: unknown) => mutate(path, input);
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
export const trpc = proxy();
export const client = proxy();
