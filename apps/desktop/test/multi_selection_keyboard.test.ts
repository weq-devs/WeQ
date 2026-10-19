import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMultiSelection } from '../src/renderer/src/hooks/useMultiSelection';
import { WindowedList } from '../src/renderer/src/components/WindowedList';
import { CheckPillGroup } from '../src/renderer/src/components/settings/controls';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('共用多选支持修饰键范围、全选/清空、键盘切换，且不吞搜索框快捷键', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture() {
    const [selected, setSelected] = useState(new Set<string>());
    const selection = useMultiSelection({
      ids: ['a', 'b', 'c', 'd'],
      selected,
      onChange: setSelected,
    });
    return h(
      'div',
      selection.rootProps,
      h('input', { 'aria-label': '搜索' }),
      ...['a', 'b', 'c', 'd'].map((id) =>
        h('button', { key: id, ...selection.itemProps(id), 'aria-pressed': selected.has(id) }, id),
      ),
    );
  }
  const click = (id: string, modifiers = {}) =>
    act(() =>
      host
        .querySelector<HTMLElement>(`[data-weq-select-id="${id}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifiers })),
    );
  const selected = () =>
    [...host.querySelectorAll('[aria-pressed="true"]')].map((item) => item.textContent);
  try {
    act(() => root.render(h(Fixture)));
    click('a', { ctrlKey: true });
    click('c', { shiftKey: true });
    expect(selected()).toEqual(['a', 'b', 'c']);
    click('d', { metaKey: true });
    expect(selected()).toEqual(['a', 'b', 'c', 'd']);
    const item = host.querySelector<HTMLElement>('[data-weq-select-id="d"]')!;
    act(() =>
      item.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'a', ctrlKey: true, shiftKey: true }),
      ),
    );
    expect(selected()).toEqual([]);
    act(() =>
      item.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', metaKey: true })),
    );
    expect(selected()).toHaveLength(4);
    act(() => item.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' })));
    expect(selected()).toEqual(['a', 'b', 'c']);
    const inputEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'a',
      ctrlKey: true,
    });
    act(() => host.querySelector('input')!.dispatchEvent(inputEvent));
    expect(inputEvent.defaultPrevented).toBe(false);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('修饰键在按下后松开也只选择一次，不误打开预览', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const opened = vi.fn();
  function Fixture() {
    const [selected, setSelected] = useState(new Set<string>());
    const selection = useMultiSelection({
      ids: ['a'],
      selected,
      onChange: setSelected,
      normalClick: 'passthrough',
    });
    return h(
      'div',
      selection.rootProps,
      h(
        'button',
        { ...selection.itemProps('a'), 'aria-pressed': selected.has('a'), onClick: opened },
        'a',
      ),
    );
  }
  try {
    act(() => root.render(h(Fixture)));
    const item = host.querySelector('button')!;
    act(() =>
      item.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, ctrlKey: true }),
      ),
    );
    act(() => item.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })));
    expect(item.getAttribute('aria-pressed')).toBe('true');
    expect(opened).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('真实 checkbox 点击和 Space 与受控选择一致，不发生双切换', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture() {
    const [selected, setSelected] = useState(new Set<string>());
    const selection = useMultiSelection({ ids: ['a', 'b'], selected, onChange: setSelected });
    return h(
      'div',
      selection.rootProps,
      ...['a', 'b'].map((id) =>
        h(
          'label',
          { key: id, ...selection.itemProps(id) },
          h('input', { type: 'checkbox', checked: selected.has(id), readOnly: true }),
          id,
        ),
      ),
    );
  }
  try {
    act(() => root.render(h(Fixture)));
    const checkbox = host.querySelector<HTMLInputElement>('input')!;
    act(() => checkbox.click());
    expect(checkbox.checked).toBe(true);
    act(() =>
      checkbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
      ),
    );
    expect(checkbox.checked).toBe(false);
    act(() =>
      checkbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    expect(
      [...host.querySelectorAll<HTMLInputElement>('input')].every((input) => input.checked),
    ).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('工具按钮聚焦后仍能全选，但隐藏列表和其它模态窗口不接管快捷键', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture({ hidden = false, modal = false, locked = false }) {
    const [selected, setSelected] = useState(new Set<string>());
    const selection = useMultiSelection({
      ids: ['a', 'b'],
      selected,
      onChange: setSelected,
      disabled: locked,
    });
    return h(
      'div',
      null,
      h(
        'div',
        { hidden },
        h(
          'div',
          selection.rootProps,
          ...['a', 'b'].map((id) =>
            h(
              'button',
              { key: id, ...selection.itemProps(id), 'aria-pressed': selected.has(id) },
              id,
            ),
          ),
        ),
      ),
      h(
        'div',
        modal ? { role: 'dialog', 'aria-modal': true } : {},
        h('button', { id: 'outside' }, '工具'),
      ),
    );
  }
  const keys = (shiftKey = false) =>
    act(() =>
      host.querySelector('#outside')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'a',
          ctrlKey: true,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  try {
    act(() => root.render(h(Fixture, {})));
    act(() => host.querySelector<HTMLButtonElement>('[data-weq-select-id="a"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('#outside')!.focus());
    keys();
    expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    act(() => root.render(h(Fixture, { hidden: true })));
    keys(true);
    expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    act(() => root.render(h(Fixture, { modal: true })));
    keys(true);
    expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    act(() => root.render(h(Fixture, { locked: true })));
    keys(true);
    expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('窗口化列表支持 Shift+End 选择与定位末尾，不挂载全部条目', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ids = Array.from({ length: 2000 }, (_, index) => String(index));
  function Fixture() {
    const [selected, setSelected] = useState(new Set<string>());
    const selection = useMultiSelection({ ids, selected, onChange: setSelected });
    return h(
      'div',
      selection.rootProps,
      h('output', null, selected.size),
      h(WindowedList<string>, {
        items: ids,
        rowHeight: 40,
        height: 300,
        itemKey: String,
        scrollToKey: selection.focusRequest?.id,
        scrollRevision: selection.focusRequest?.revision,
        renderItem: (id) =>
          h('button', { ...selection.itemProps(id), 'aria-pressed': selected.has(id) }, id),
      }),
    );
  }
  try {
    act(() => root.render(h(Fixture)));
    const first = host.querySelector<HTMLButtonElement>('[data-weq-select-id="0"]')!;
    act(() => first.click());
    act(() =>
      first.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'End',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(host.querySelector('output')?.textContent).toBe('2000');
    expect(document.activeElement?.getAttribute('data-weq-select-id')).toBe('1999');
    expect(host.querySelectorAll('[data-weq-select-id]').length).toBeLessThan(30);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});

it('模型能力多选一次性提交完整范围，不被逐条回调的旧状态覆盖', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture() {
    const [selected, setSelected] = useState<string[]>([]);
    return h(CheckPillGroup, {
      options: ['chat', 'vision', 'voice'].map((value) => ({ value, label: value })),
      selected,
      onChange: setSelected,
    });
  }
  try {
    act(() => root.render(h(Fixture)));
    const buttons = host.querySelectorAll('button');
    act(() => buttons[0]!.click());
    act(() =>
      buttons[2]!.dispatchEvent(
        new MouseEvent('click', { shiftKey: true, bubbles: true, cancelable: true }),
      ),
    );
    expect(host.querySelectorAll('[aria-checked="true"]')).toHaveLength(3);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('从工具行进入多选后焦点落到候选项，Space 可直接选取', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture() {
    const [enabled, setEnabled] = useState(false);
    const [selected, setSelected] = useState(new Set<string>());
    const multi = useMultiSelection({ ids: ['a'], selected, onChange: setSelected, enabled });
    return h(
      'div',
      null,
      h('button', { id: 'enter', onClick: () => setEnabled(true) }, '多选'),
      h(
        'div',
        multi.rootProps,
        h('button', { ...multi.itemProps('a'), 'aria-pressed': selected.has('a') }, 'a'),
      ),
    );
  }
  try {
    act(() => root.render(h(Fixture)));
    act(() => host.querySelector<HTMLButtonElement>('#enter')!.click());
    expect(document.activeElement?.getAttribute('data-weq-select-id')).toBe('a');
    act(() =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
      ),
    );
    expect(host.querySelector('[aria-pressed="true"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
