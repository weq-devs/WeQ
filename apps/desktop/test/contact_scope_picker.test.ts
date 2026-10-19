import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContactScopePicker,
  type ContactChoice,
} from '../src/renderer/src/views/export/ContactScopePicker';

function mount(items: ContactChoice[], initial?: string[]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let selected: string[] | undefined;
  function Harness() {
    const [ids, setIds] = useState(initial);
    selected = ids;
    return createElement(ContactScopePicker, {
      items,
      selected: ids,
      onChange: setIds,
      loading: false,
      error: false,
      onRetry: vi.fn(),
      conditionLabel: '全部好友',
    });
  }
  act(() => root.render(createElement(Harness)));
  return {
    host,
    get selected() {
      return selected;
    },
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('联系人精确范围选择器', () => {
  it('五千联系人保持有界 DOM，条件范围与精确空集合明确区分', () => {
    const items = Array.from({ length: 5000 }, (_, index) => ({
      uid: `u_${index}`,
      uin: '0',
      name: `合成好友 ${index}`,
      categoryId: 0,
    }));
    const f = mount(items);
    try {
      expect(f.host.querySelectorAll('.weq-exp-row').length).toBeLessThan(40);
      expect(f.selected).toBeUndefined();
      expect(f.host.textContent).toContain('全部好友');
      act(() => f.host.querySelector<HTMLInputElement>('[aria-label="精确选择联系人"]')!.click());
      expect(f.selected).toEqual([]);
      expect(f.host.textContent).toContain('已选 0 位联系人');
      act(() => f.host.querySelector<HTMLInputElement>('[aria-label="精确选择联系人"]')!.click());
      expect(f.selected).toBeUndefined();
    } finally {
      f.close();
    }
  });
  it('按 QQ 号搜索，快捷全选追加当前结果而不丢弃筛选外选择，快捷清空清除整个草稿', () => {
    const f = mount(
      [
        { uid: 'a', uin: '10001', name: '合成甲', categoryId: 0 },
        { uid: 'b', uin: '10002', name: '合成乙', categoryId: 0 },
      ],
      ['a'],
    );
    try {
      const input = f.host.querySelector<HTMLInputElement>('[placeholder="搜索昵称或 QQ 号"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '10002',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(f.host.querySelectorAll('.weq-exp-row')).toHaveLength(1);
      const row = f.host.querySelector<HTMLButtonElement>('.weq-exp-row')!;
      act(() => {
        row.focus();
        row.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(f.selected).toEqual(['a', 'b']);
      act(() =>
        row.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(f.selected).toEqual([]);
    } finally {
      f.close();
    }
  });
  it('列表外选择不会静默丢弃，只有明确清除操作才移除', () => {
    const f = mount([{ uid: 'a', uin: '10001', name: '合成甲', categoryId: 0 }], ['a', 'outside']);
    try {
      expect(f.selected).toEqual(['a', 'outside']);
      expect(f.host.textContent).toContain('当前列表之外仍选中 1 位联系人');
      act(() =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="清除列表外的选择"]')!.click(),
      );
      expect(f.selected).toEqual(['a']);
    } finally {
      f.close();
    }
  });
});
