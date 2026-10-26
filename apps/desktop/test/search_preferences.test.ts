import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  readSearchPreferences,
  SEARCH_PREFERENCES_KEY,
  useSearchPreferences,
} from '../src/renderer/src/hooks/useSearchPreferences';
import { SEARCH_CATEGORY_ORDER } from '../src/renderer/src/components/search/types';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  window.localStorage.removeItem(SEARCH_PREFERENCES_KEY);
});
afterEach(() => {
  window.localStorage.removeItem(SEARCH_PREFERENCES_KEY);
  vi.unstubAllGlobals();
});

it('默认全选；保存分类及功能开关，重新挂载恢复，包括空选择', () => {
  expect(readSearchPreferences()).toEqual({ categories: SEARCH_CATEGORY_ORDER, appEnabled: true });
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
  });
  act(() => root.unmount());
  root = createRoot(host);
  act(() => root.render(h(Harness)));
  expect(state!.categories).toEqual(['file']);
  expect(state!.appEnabled).toBe(false);
  act(() => state.setCategories([]));
  act(() => root.unmount());
  expect(readSearchPreferences()).toEqual({ categories: [], appEnabled: false });
});

it('忽略旧分类、非法数据；损坏的存储回退全选', () => {
  window.localStorage.setItem(
    SEARCH_PREFERENCES_KEY,
    JSON.stringify({
      categories: ['marketEmoji', 'guildMessage', 'cloneMessage', 'file', 'file', 'unknown'],
    }),
  );
  expect(readSearchPreferences().categories).toEqual(['file']);
  window.localStorage.setItem(SEARCH_PREFERENCES_KEY, '{');
  expect(readSearchPreferences().categories).toEqual(SEARCH_CATEGORY_ORDER);
});
