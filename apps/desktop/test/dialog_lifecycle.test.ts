import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DialogHost, useDialog } from '../src/renderer/src/components/Dialog';

afterEach(() => {
  useDialog.getState().close();
  vi.unstubAllGlobals();
});

it.each(['error', 'info', 'confirm', 'password', 'close'])(
  'settles the displaced confirmation on %s',
  async (kind) => {
    const done = vi.fn();
    const old = useDialog.getState().confirm('旧确认', '合成内容').then(done);
    if (kind === 'error') useDialog.getState().showError('错误', '合成错误');
    if (kind === 'info') useDialog.getState().showInfo('提示', '合成提示');
    if (kind === 'confirm') void useDialog.getState().confirm('新确认', '合成内容');
    if (kind === 'password') void useDialog.getState().promptPassword('新密码', '合成内容');
    if (kind === 'close') useDialog.getState().close();
    await Promise.resolve();
    expect(done.mock.calls).toEqual([[false]]);
    await old;
  },
);

it('settles a displaced password without leaking a late value into the new request', async () => {
  const done = vi.fn();
  void useDialog.getState().promptPassword('旧密码', '合成内容').then(done);
  const previous = useDialog.getState().current!;
  useDialog.getState().showError('新错误', '合成内容');
  await Promise.resolve();
  expect(done.mock.calls).toEqual([[null]]);
  previous.password!.resolve('late-synthetic-value');
  useDialog.getState().close(previous.id);
  await Promise.resolve();
  expect(done).toHaveBeenCalledOnce();
  expect(useDialog.getState().current?.title).toBe('新错误');
});

it('host unmount cancels its pending confirmation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(DialogHost)));
  const done = vi.fn();
  act(() => {
    void useDialog.getState().confirm('合成确认', '合成内容').then(done);
  });
  act(() => root.unmount());
  await Promise.resolve();
  expect(done.mock.calls).toEqual([[false]]);
  host.remove();
});
