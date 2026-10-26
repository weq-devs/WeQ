import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolSurface } from '../src/renderer/src/components/ToolSurface';
import { DialogHost, useDialog } from '../src/renderer/src/components/Dialog';
import { useDraftProtection } from '../src/renderer/src/lib/draftClose';
import { hasActiveModal } from '../src/renderer/src/lib/overlayStack';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

afterEach(() => {
  useDialog.setState({ current: null });
  vi.unstubAllGlobals();
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    render: (content: Parameters<typeof root.render>[0]) => act(() => root.render(content)),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const pressEscape = () =>
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

describe('工具页面与设置模态共用内容', () => {
  it('失活时解除背景隔离，恢复活动时重新隔离，不残留看不见的遮罩', () => {
    const f = mount();
    const render = (active: boolean) =>
      f.render(
        h(
          TabActivity,
          { active },
          h(
            ToolSurface,
            { title: '活动工具', presentation: 'modal', onClose: vi.fn() },
            h('button', null, '操作'),
          ),
        ),
      );
    try {
      render(true);
      expect(f.host.hasAttribute('inert')).toBe(true);
      render(false);
      expect(f.host.hasAttribute('inert')).toBe(false);
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      render(true);
      expect(f.host.hasAttribute('inert')).toBe(true);
      expect(document.querySelector('.weq-tool-modal')).not.toBeNull();
    } finally {
      f.close();
    }
  });
  it('非设置来源默认仍为页面，只有显式 modal 才锁背景', () => {
    const f = mount();
    try {
      f.render(h(ToolSurface, { title: '合成工具', onClose: vi.fn() }, h('input')));
      expect(f.host.querySelector('.weq-workspace-page')).not.toBeNull();
      expect(hasActiveModal()).toBe(false);
      f.render(
        h(ToolSurface, { title: '合成工具', onClose: vi.fn(), presentation: 'modal' }, h('input')),
      );
      expect(f.host.querySelector('.weq-workspace-page')).toBeNull();
      expect(hasActiveModal()).toBe(true);
      expect(f.host.hasAttribute('inert')).toBe(true);
    } finally {
      f.close();
    }
    expect(f.host.hasAttribute('inert')).toBe(false);
  });

  it('只有顶层工具响应 Escape，Tab 首尾循环且关闭后恢复焦点', () => {
    const f = mount();
    const outer = vi.fn(),
      inner = vi.fn();
    const render = (nested: boolean) =>
      f.render(
        h(
          ToolSurface,
          { title: '外层', presentation: 'modal', onClose: outer },
          h('button', { 'data-outer': true }, '入口'),
          nested &&
            h(
              ToolSurface,
              { title: '内层', presentation: 'modal', onClose: inner },
              h('button', { 'data-first': true }, '第一项'),
              h('button', { 'data-last': true }, '最后一项'),
            ),
        ),
      );
    try {
      render(false);
      const trigger = document.querySelector<HTMLButtonElement>('[data-outer]')!;
      act(() => trigger.focus());
      render(true);
      const first = document.querySelector<HTMLButtonElement>('[data-first]')!;
      const last = document.querySelector<HTMLButtonElement>('[data-last]')!;
      act(() => {
        last.focus();
        last.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
        );
      });
      expect(document.activeElement).toBe(first);
      act(() =>
        first.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Tab',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(document.activeElement).toBe(last);
      pressEscape();
      expect(inner).toHaveBeenCalledOnce();
      expect(outer).not.toHaveBeenCalled();
      render(false);
      expect(document.activeElement).toBe(trigger);
      expect(f.host.hasAttribute('inert')).toBe(true);
    } finally {
      f.close();
    }
    expect(f.host.hasAttribute('inert')).toBe(false);
  });

  it('嵌套工具一并卸载不残留 inert，原本 inert 的背景保持原状', () => {
    const f = mount();
    const original = document.createElement('div');
    original.setAttribute('inert', '');
    document.body.append(original);
    try {
      f.render(
        h(
          ToolSurface,
          { title: '父工具', presentation: 'modal', onClose: vi.fn() },
          h(
            ToolSurface,
            { title: '子工具', presentation: 'modal', onClose: vi.fn() },
            h('button', null, '操作'),
          ),
        ),
      );
      f.render(null);
      expect(f.host.hasAttribute('inert')).toBe(false);
      expect(original.hasAttribute('inert')).toBe(true);
    } finally {
      f.close();
      original.remove();
    }
  });

  it('关闭按钮和 Escape 都遵守草稿确认，取消后保留输入，执行中拒绝关闭', async () => {
    const f = mount();
    const closed = vi.fn();
    let setBusy = (_busy: boolean) => {};
    function Draft() {
      const [value, setValue] = useState('');
      const [busy, updateBusy] = useState(false);
      setBusy = updateBusy;
      useDraftProtection(value, busy);
      return h('input', {
        'aria-label': '合成草稿',
        value,
        onChange: (event) => setValue(event.target.value),
      });
    }
    function View() {
      return h(
        'div',
        null,
        h(
          ToolSurface,
          {
            title: '草稿工具',
            presentation: 'modal',
            onClose: closed,
          },
          (requestClose: () => void) =>
            h(
              'div',
              null,
              h(Draft),
              h('button', { 'aria-label': '关闭工具', onClick: requestClose }, '关闭'),
            ),
        ),
        h(DialogHost),
      );
    }
    try {
      f.render(h(View));
      const input = document.querySelector<HTMLInputElement>('[aria-label="合成草稿"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '未保存',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      pressEscape();
      expect(useDialog.getState().current?.title).toBe('放弃未保存的修改？');
      await act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '继续编辑')!
          .click(),
      );
      expect(closed).not.toHaveBeenCalled();
      expect(input.value).toBe('未保存');
      act(() => setBusy(true));
      pressEscape();
      expect(useDialog.getState().current).toBeNull();
      expect(closed).not.toHaveBeenCalled();
      act(() => setBusy(false));
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭工具"]')!.click());
      await act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '放弃修改')!
          .click(),
      );
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });
});
