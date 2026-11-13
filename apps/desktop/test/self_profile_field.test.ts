import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  SelfProfileField,
  SelfProfileEditingContext,
} from '../src/renderer/src/components/SelfProfileField';
import { QQWriteTextRow } from '../src/renderer/src/components/QQWriteControls';

const cleanups: (() => void)[] = [];
function fixture(save = vi.fn(async () => true), multiline = false) {
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
            multiline,
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
  const trigger = f.host.querySelector<HTMLButtonElement>('[aria-label="编辑昵称"]')!;
  expect(trigger.textContent).toBe('原值');
  expect(trigger.querySelector('svg')).toBeNull();
  expect(trigger.querySelector('button')).toBeNull();
  expect(f.host.textContent).toContain('原值');
  expect(f.host.querySelector('input')).toBeNull();
  const label = f.host.querySelector('.weq-profile-data-label');
  await f.click('编辑昵称');
  expect(f.host.querySelector('.weq-profile-data-label')).toBe(label);
  expect(f.host.querySelector('.weq-set-row-label')).toBeNull();
  expect(f.host.querySelector('.weq-profile-data-value input')).not.toBeNull();
  expect(f.host.querySelector('.weq-profile-field-actions [aria-label="保存昵称"]')).not.toBeNull();
  expect(f.host.querySelector('input')).not.toBeNull();
  await f.click('取消编辑昵称');
  expect(f.save).not.toHaveBeenCalled();
  expect(f.host.querySelector('input')).toBeNull();
  await f.click('编辑昵称');
  expect(f.host.querySelector('input')?.value).toBe('原值');
});

it('Enter 保存单行输入，输入法确认不提交', async () => {
  const f = fixture();
  await f.click('编辑昵称');
  const input = f.host.querySelector('input')!;
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    ),
  );
  expect(f.save).not.toHaveBeenCalled();
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    ),
  );
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.host.querySelector('input')).toBeNull();
});
it('多行输入 Enter 保留换行语义，Ctrl+Enter 才保存', async () => {
  const f = fixture(
    vi.fn(async () => true),
    true,
  );
  await f.click('编辑昵称');
  const input = f.host.querySelector('textarea')!;
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  act(() => input.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(false);
  expect(f.save).not.toHaveBeenCalled();
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(f.save).toHaveBeenCalledOnce();
});
it('拖选字段文字不进入编辑；键盘点击仍可编辑', async () => {
  const f = fixture();
  const trigger = f.host.querySelector<HTMLButtonElement>('[aria-label="编辑昵称"]')!;
  const range = document.createRange();
  range.selectNodeContents(trigger);
  document.getSelection()!.addRange(range);
  await f.click('编辑昵称');
  expect(f.host.querySelector('input')).toBeNull();
  document.getSelection()!.removeAllRanges();
  await f.click('编辑昵称');
  expect(f.host.querySelector('input')).not.toBeNull();
});
it.each([false, true])('不可编辑（禁用=%s）时字段为纯文本，不提供复制入口', (disabled) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() =>
    root.render(
      h(
        SelfProfileEditingContext.Provider,
        { value: disabled },
        h(SelfProfileField, { label: '昵称', value: '原值', disabled }, h('input')),
      ),
    ),
  );
  expect(host.querySelector('button, input')).toBeNull();
  expect(host.textContent).toContain('原值');
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
it('内容已有对话框操作时不嵌套按钮或添加编辑按钮', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const history = vi.fn();
  act(() =>
    root.render(
      h(
        SelfProfileField,
        {
          label: '学校',
          value: '原学校',
          valueHasAction: true,
          renderValue: (value) => h('button', { type: 'button', onClick: history }, value),
        },
        h('input', { 'aria-label': '学校' }),
      ),
    ),
  );
  expect(host.querySelector('button button')).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('.weq-self-field-value button')!.click());
  expect(history).toHaveBeenCalledOnce();
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector('[aria-label="编辑学校"]')).toBeNull();
});
