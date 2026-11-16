import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DialogHost, useDialog, type DangerLevel } from '../src/renderer/src/components/Dialog';

const cleanups: (() => void)[] = [];
afterEach(() => {
  act(() => useDialog.getState().close());
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(DialogHost)));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
}

it.each<DangerLevel>(['outline', 'solid'])(
  '危险确认使用显式 %s 等级，取消不继承危险样式',
  async (danger) => {
    mount();
    let result!: Promise<boolean>;
    act(() => {
      result = useDialog
        .getState()
        .confirm('合成危险操作', '合成内容', { danger, okLabel: '执行' });
    });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.weq-dialog-foot button')];
    expect(buttons.map((button) => button.dataset.danger)).toEqual([undefined, danger]);
    await act(async () => buttons[0]!.click());
    expect(await result).toBe(false);
  },
);

it.each(['warning', 'error'] as const)('普通 %s 提示或确认不自动变成危险操作', (tone) => {
  mount();
  act(() => {
    void useDialog.getState().confirm('继续导出', '合成提示', { tone });
  });
  expect(document.querySelector('[data-danger]')).toBeNull();
  act(() => useDialog.getState().showError('合成错误', '请重试'));
  expect(document.querySelector('[data-danger]')).toBeNull();
});

it('替换确认时不把上一项的危险等级带到普通确认', () => {
  mount();
  act(() => {
    void useDialog.getState().confirm('删除', '合成内容', { danger: 'solid' });
  });
  act(() => {
    void useDialog.getState().confirm('继续', '合成内容');
  });
  expect(document.querySelector('[data-danger]')).toBeNull();
});
