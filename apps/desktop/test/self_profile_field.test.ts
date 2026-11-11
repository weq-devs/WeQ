import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SelfProfileField } from '../src/renderer/src/components/SelfProfileField';
import { QQWriteTextRow } from '../src/renderer/src/components/QQWriteControls';

const cleanups: (() => void)[] = [];
function fixture(save = vi.fn(async () => true)) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (identity = 'a') =>
    act(() =>
      root.render(
        h(
          SelfProfileField,
          {
            key: identity,
            label: '昵称',
            value: '原值',
          },
          h(QQWriteTextRow, {
            label: '昵称',
            initial: '原值',
            disabled: false,
            onSave: save,
          }),
        ),
      ),
    );
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const click = async (label: string) =>
    act(async () => {
      host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
    });
  return { host, render, click, save };
}
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  vi.unstubAllGlobals();
});
it('默认显示资料而不是表单，取消不提交，重开恢复原值', async () => {
  const f = fixture();
  expect(f.host.textContent).toContain('原值');
  expect(f.host.querySelector('input')).toBeNull();
  await f.click('编辑昵称');
  expect(f.host.querySelector('input')).not.toBeNull();
  await f.click('取消编辑昵称');
  expect(f.save).not.toHaveBeenCalled();
  expect(f.host.querySelector('input')).toBeNull();
  await f.click('编辑昵称');
  expect(f.host.querySelector('input')?.value).toBe('原值');
});
it('失败保留编辑器与草稿，确认成功才收起', async () => {
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const f = fixture(save);
  await f.click('编辑昵称');
  const field = f.host.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '草稿');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await f.click('保存昵称');
  expect(f.host.querySelector('input')?.value).toBe('草稿');
  await f.click('保存昵称');
  expect(f.host.querySelector('input')).toBeNull();
  expect(save).toHaveBeenLastCalledWith('草稿');
});
it('来源变更销毁旧编辑草稿', async () => {
  const f = fixture();
  await f.click('编辑昵称');
  f.render('b');
  expect(f.host.querySelector('input')).toBeNull();
  expect(f.save).not.toHaveBeenCalled();
});
