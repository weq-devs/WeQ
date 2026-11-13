import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSettingsAutosave } from '../src/renderer/src/hooks/useSettingsAutosave';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture(save = vi.fn(async (_patch: { text?: string; count?: number }) => {})) {
  let form!: ReturnType<typeof useSettingsAutosave<{ text?: string; count?: number }>>;
  const host = document.createElement('div');
  const root = createRoot(host);
  function Harness() {
    form = useSettingsAutosave(save);
    return h('span', null, form.status);
  }
  act(() => root.render(h(Harness)));
  const edit = (text: string, valid = true) =>
    act(() => form.register('text', { snapshot: text, patch: { text }, valid }));
  edit('initial');
  return {
    get form() {
      return form;
    },
    save,
    edit,
    close: () => act(() => root.unmount()),
  };
}
it('输入立即变为未保存，500ms 合并输入，成功后才确认当前版本', async () => {
  const f = fixture();
  try {
    f.edit('a');
    f.edit('ab');
    expect(f.form.status).toBe('未保存');
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(f.save).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.save).toHaveBeenCalledWith({ text: 'ab' });
    expect(f.form.status).toBe('已保存');
  } finally {
    f.close();
  }
});
it('在途修改串行进入下一批，不被前一回执确认为已保存', async () => {
  let release!: () => void;
  const save = vi.fn(async (_patch: { text?: string; count?: number }) => {});
  save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const f = fixture(save);
  try {
    f.edit('first');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    f.edit('second');
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(save.mock.calls.map(([patch]) => patch.text)).toEqual(['first', 'second']);
    expect(f.form.dirty).toBe(false);
  } finally {
    f.close();
  }
});
it('无效输入不提交且阻止关闭，失败保留草稿，显式重试补交成功', async () => {
  const f = fixture();
  try {
    f.edit('invalid', false);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await act(async () => expect(await f.form.flush()).toBe(false));
    expect(f.save).not.toHaveBeenCalled();
    f.edit('valid');
    f.save.mockRejectedValueOnce(new Error('合成失败'));
    await act(async () => expect(await f.form.flush()).toBe(false));
    expect(f.form.error).toBe('合成失败');
    expect(f.form.dirty).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(f.save).toHaveBeenCalledTimes(1);
    await act(async () => expect(await f.form.flush()).toBe(true));
    expect(f.form.status).toBe('已保存');
  } finally {
    f.close();
  }
});
