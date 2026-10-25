import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SegmentedControl } from '../src/renderer/src/components/SegmentedControl';

it('支持互斥选择、未知值、键盘跳过禁用项和父级 fieldset 禁用', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const change = vi.fn();
  const render = (disabled: boolean, value: string | null) =>
    act(() =>
      root.render(
        createElement(
          'fieldset',
          { disabled },
          createElement(SegmentedControl<string>, {
            label: '运行方式',
            value,
            onChange: change,
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B', disabled: true },
              { value: 'c', label: 'C' },
            ],
          }),
        ),
      ),
    );
  try {
    render(false, null);
    const buttons = [...host.querySelectorAll('button')];
    expect(host.querySelector('[aria-checked="true"]')).toBeNull();
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);
    act(() =>
      buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    expect(change).toHaveBeenLastCalledWith('c');
    expect(document.activeElement).toBe(buttons[2]);
    render(false, 'c');
    expect(buttons.map((button) => button.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ]);
    act(() =>
      buttons[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })),
    );
    expect(change).toHaveBeenLastCalledWith('a');
    change.mockClear();
    render(true, 'a');
    act(() => buttons[0]!.click());
    expect(change).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
