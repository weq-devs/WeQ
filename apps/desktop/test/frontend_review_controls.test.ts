import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MailListResizeHandle } from '../src/renderer/src/views/mail/MailListResizeHandle';
import { useExactSelectionMode } from '../src/renderer/src/views/export/useExactSelectionMode';
import { validatePreferencePatch, preferenceDefaults } from '@weq/service/client-preferences';

afterEach(() => vi.unstubAllGlobals());
it('邮箱列宽属于共享偏好，拒绝越界、非数值及非有限值', () => {
  expect(preferenceDefaults.mailListWidth).toBe(360);
  for (const mailListWidth of [280, 360, 560])
    expect(() => validatePreferencePatch({ mailListWidth })).not.toThrow();
  for (const mailListWidth of [279, 561, NaN, Infinity, '360'])
    expect(() => validatePreferencePatch({ mailListWidth })).toThrow();
});
it('分隔条键盘调整遵守当前可用宽度，Home 恢复下限', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const commit = vi.fn();
  function Harness() {
    const [width, setWidth] = useState(360);
    return h(MailListResizeHandle, { width, max: 400, onChange: setWidth, onCommit: commit });
  }
  try {
    act(() => root.render(h(Harness)));
    const separator = host.querySelector('[role="separator"]')!;
    const press = (key: string) =>
      act(() => separator.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    press('ArrowRight');
    expect(commit).toHaveBeenLastCalledWith(376);
    press('End');
    expect(commit).toHaveBeenLastCalledWith(400);
    press('ArrowRight');
    expect(commit).toHaveBeenLastCalledWith(400);
    press('Home');
    expect(commit).toHaveBeenLastCalledWith(280);
  } finally {
    act(() => root.unmount());
  }
});
it('导出精确选择在同一目标恢复，换目标后从空集合开始', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  let changeMode!: (mode: 'condition' | 'exact') => void;
  let select!: (ids: string[]) => void;
  let current: readonly string[] | undefined;
  function Harness({ scope }: { scope: string }) {
    const [ids, setIds] = useState<string[]>();
    current = ids;
    select = setIds;
    changeMode = useExactSelectionMode(scope, ids, setIds);
    return null;
  }
  try {
    act(() => root.render(h(Harness, { scope: 'account:a' })));
    act(() => changeMode('exact'));
    expect(current).toEqual([]);
    act(() => select(['message']));
    act(() => changeMode('condition'));
    expect(current).toBeUndefined();
    act(() => changeMode('exact'));
    expect(current).toEqual(['message']);
    act(() => changeMode('condition'));
    act(() => root.render(h(Harness, { scope: 'account:b' })));
    act(() => changeMode('exact'));
    expect(current).toEqual([]);
  } finally {
    act(() => root.unmount());
  }
});
