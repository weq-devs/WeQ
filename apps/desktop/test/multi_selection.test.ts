import { describe, expect, it } from 'vitest';
import {
  allSelectionIdsSelected,
  toggleAllSelectionIds,
} from '../src/renderer/src/lib/multiSelection';

describe('工具栏全选切换', () => {
  it('未选和部分选择时补齐当前结果，再次点击取消全选，不修改原选区', () => {
    const ids = ['a', 'b'];
    const initial = new Set<string>();
    const selected = toggleAllSelectionIds(ids, initial);
    expect(selected).toEqual(new Set(ids));
    expect(initial.size).toBe(0);
    expect(allSelectionIdsSelected(ids, selected)).toBe(true);
    expect(toggleAllSelectionIds(ids, selected)).toEqual(new Set());
    expect(selected).toEqual(new Set(ids));
    expect(toggleAllSelectionIds(ids, new Set(['a']))).toEqual(new Set(ids));
  });

  it('全选和取消全选都保留筛选外选项，不能用总数判断当前结果是否全选', () => {
    const ids = ['a', 'b'];
    const initial = new Set(['a', 'outside']);
    expect(allSelectionIdsSelected(ids, initial)).toBe(false);
    const selected = toggleAllSelectionIds(ids, initial);
    expect(selected).toEqual(new Set(['a', 'b', 'outside']));
    expect(toggleAllSelectionIds(ids, selected)).toEqual(new Set(['outside']));
  });

  it('空结果不视为全选，也不清除已有选区', () => {
    const selected = new Set([1]);
    expect(allSelectionIdsSelected([], selected)).toBe(false);
    expect(toggleAllSelectionIds([], selected)).toEqual(selected);
    expect(toggleAllSelectionIds([1, 2], selected)).toEqual(new Set([1, 2]));
  });
});
