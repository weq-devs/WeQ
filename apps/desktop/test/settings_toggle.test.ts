import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toggle } from '../src/renderer/src/components/settings/controls';

const cleanups: Array<() => void> = [];

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, root };
}

describe('通用设置开关', () => {
  it.each([false, true])('部分开启时忽略 checked=%s，点击请求全开', (checked) => {
    const f = fixture();
    const change = vi.fn();
    act(() =>
      f.root.render(h(Toggle, { checked, mixed: true, onChange: change, label: '消息提醒' })),
    );
    const button = f.host.querySelector<HTMLButtonElement>('button')!;
    expect(button.getAttribute('role')).toBe('checkbox');
    expect(button.getAttribute('aria-checked')).toBe('mixed');
    act(() => button.click());
    expect(change).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith(true);
  });

  it('部分开启保留独立可访问语义，装饰轨道不重复朗读', () => {
    const f = fixture();
    act(() =>
      f.root.render(h(Toggle, { checked: false, mixed: true, onChange: vi.fn(), label: '提醒' })),
    );
    expect(f.host.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('mixed');
    expect(f.host.querySelector('.weq-set-toggle-track')?.getAttribute('aria-hidden')).toBe('true');
  });

  it.each([false, true])('二态开关 checked=%s 保持原有语义和切换行为', (checked) => {
    const f = fixture();
    const change = vi.fn();
    act(() => f.root.render(h(Toggle, { checked, onChange: change, label: '提醒' })));
    const button = f.host.querySelector<HTMLButtonElement>('button')!;
    expect(button.getAttribute('role')).toBe('switch');
    expect(button.getAttribute('aria-checked')).toBe(String(checked));
    expect(button.querySelector('.lucide-minus')).toBeNull();
    act(() => button.click());
    expect(change).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith(!checked);
  });

  it.each([false, true])('禁用的混合态 checked=%s 不提交修改', (checked) => {
    const f = fixture();
    const change = vi.fn();
    act(() => f.root.render(h(Toggle, { checked, mixed: true, disabled: true, onChange: change })));
    const button = f.host.querySelector<HTMLButtonElement>('button')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-checked')).toBe('mixed');
    act(() => button.click());
    expect(change).not.toHaveBeenCalled();
  });

  it('父项依子项汇总，部分开启到全开，再全关、全开', () => {
    const f = fixture();
    function Group() {
      const [children, setChildren] = useState([true, false]);
      const all = children.every(Boolean);
      return h(Toggle, {
        checked: all,
        mixed: !all && children.some(Boolean),
        onChange: (value) => setChildren(children.map(() => value)),
        label: '全部提醒',
      });
    }
    act(() => f.root.render(h(Group)));
    const button = f.host.querySelector<HTMLButtonElement>('button')!;
    expect(button.getAttribute('aria-checked')).toBe('mixed');
    for (const expected of ['true', 'false', 'true']) {
      act(() => button.click());
      expect(button.getAttribute('aria-checked')).toBe(expected);
      expect(button.getAttribute('role')).toBe('checkbox');
    }
  });

  it.each([false, true])('未读取状态保留 checked=%s 的双向请求，不当作部分开启', (checked) => {
    const f = fixture();
    const change = vi.fn();
    act(() => f.root.render(h(Toggle, { checked, indeterminate: true, onChange: change })));
    const button = f.host.querySelector<HTMLButtonElement>('button')!;
    expect(button.classList.contains('is-unknown')).toBe(true);
    expect(button.querySelector('.lucide-minus')).toBeNull();
    act(() => button.click());
    expect(change).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith(!checked);
  });
});
