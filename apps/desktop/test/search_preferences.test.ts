import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  readSearchPreferences,
  SEARCH_PREFERENCES_KEY,
  useSearchPreferences,
} from '../src/renderer/src/hooks/useSearchPreferences';
import { SEARCH_CATEGORY_ORDER } from '../src/renderer/src/components/search/types';
import { DEFAULT_SEARCH_SOURCES } from '@weq/service/search-policy';
import {
  acceptPreferences,
  preferenceValue,
  useClientPreferences,
} from '../src/renderer/src/lib/clientPreferences';

/*
 * bc972cf1 起「搜索分类与号码查询偏好」是跨端共享设置：读写都走
 * clientPreferences（共享值优先，localStorage 的 SEARCH_PREFERENCES_KEY 只用于
 * 旧安装迁移/首帧兜底），不再由本机键承担保存。
 */
const shared = vi.hoisted(() => ({
  revision: 0,
  values: {} as Record<string, unknown>,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    clientState: {
      patch: {
        mutate: async (patch: Record<string, unknown>) => {
          shared.values = { ...shared.values, ...patch };
          shared.revision += 1;
          return { revision: shared.revision, values: { ...shared.values }, records: {} };
        },
      },
      snapshot: {
        query: async () => ({
          revision: shared.revision,
          values: { ...shared.values },
          records: {},
        }),
      },
    },
  },
  trpc: { useUtils: () => ({}) },
}));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  window.localStorage.removeItem(SEARCH_PREFERENCES_KEY);
  shared.values = {};
  shared.revision = 0;
  acceptPreferences({ epoch: `test-${Date.now()}`, revision: 0, values: {}, records: {} }, false);
  useClientPreferences.setState({ error: '', tick: 0 });
});
afterEach(() => {
  window.localStorage.removeItem(SEARCH_PREFERENCES_KEY);
  vi.unstubAllGlobals();
});

it('默认全选；保存分类及功能开关，重新挂载恢复，包括空选择', () => {
  expect(readSearchPreferences()).toEqual({
    version: 2,
    sources: DEFAULT_SEARCH_SOURCES,
    categories: SEARCH_CATEGORY_ORDER,
    appEnabled: true,
    numberLookupEnabled: true,
  });
  let state: ReturnType<typeof useSearchPreferences>;
  function Harness() {
    state = useSearchPreferences();
    return null;
  }
  const host = document.createElement('div');
  let root = createRoot(host);
  act(() => root.render(h(Harness)));
  act(() => {
    state.setCategories(['file']);
    state.setAppEnabled(false);
    state.setNumberLookupEnabled(false);
  });
  act(() => root.unmount());
  root = createRoot(host);
  act(() => root.render(h(Harness)));
  expect(state!.categories).toEqual(['file']);
  expect(state!.appEnabled).toBe(false);
  expect(state!.numberLookupEnabled).toBe(false);
  act(() => state.setCategories([]));
  act(() => root.unmount());
  // 共享值是权威：空选择会保存成空数组。
  expect(preferenceValue('search')).toMatchObject({
    categories: [],
    appEnabled: false,
    numberLookupEnabled: false,
  });
  // 本机键不再是写入通道，仍然是默认值（只作旧安装迁移/兜底）。
  expect(readSearchPreferences().categories).toEqual(SEARCH_CATEGORY_ORDER);
});

it('旧分类首次重置全选，损坏的存储同样回退全选', () => {
  window.localStorage.setItem(
    SEARCH_PREFERENCES_KEY,
    JSON.stringify({
      categories: ['marketEmoji', 'guildMessage', 'cloneMessage', 'file', 'file', 'unknown'],
    }),
  );
  expect(readSearchPreferences().categories).toEqual(SEARCH_CATEGORY_ORDER);
  expect(readSearchPreferences().sources).toEqual(DEFAULT_SEARCH_SOURCES);
  expect(readSearchPreferences().numberLookupEnabled).toBe(true);
  window.localStorage.setItem(SEARCH_PREFERENCES_KEY, '{');
  expect(readSearchPreferences().categories).toEqual(SEARCH_CATEGORY_ORDER);
});
