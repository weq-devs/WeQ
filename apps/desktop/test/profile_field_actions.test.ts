import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactRow } from '../src/renderer/src/components/contactProfile/ContactRow';
import { copyTextToClipboard } from '../src/renderer/src/im-template/template/clipboard';

vi.mock('../src/renderer/src/im-template/template/clipboard', () => ({
  copyTextToClipboard: vi.fn(async () => true),
}));

const cleanups: (() => void)[] = [];
function render(label: string, onActivate?: () => void, copyValue?: string) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      h(ContactRow, {
        label,
        value: '合成内容',
        copyValue,
        onActivate,
        activateTitle: '打开关联对话框',
      }),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  document.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it.each(['QQ', 'QID', 'UID', '群号', 'ID', '邮箱'])('显式指定的 %s 提供点击复制', (label) => {
  const host = render(label, undefined, '合成内容');
  expect(host.querySelector(`[aria-label="复制 ${label}"]`)?.textContent).toBe('合成内容');
});
it.each(['昵称', '性别', '年龄', '地区', '等级', '公司', '个人说明', '备注', '成员数'])(
  '只读字段 %s 保持纯文本，不自动变成复制按钮',
  (label) => {
    const host = render(label);
    expect(host.querySelector('button')).toBeNull();
    expect(host.querySelector('svg')).toBeNull();
    expect(host.textContent).toContain('合成内容');
  },
);
it('关联对话框的字段点击打开，不走复制', () => {
  const open = vi.fn();
  const host = render('学校', open, '合成内容');
  const button = host.querySelector<HTMLButtonElement>('button')!;
  act(() => button.click());
  expect(open).toHaveBeenCalledOnce();
  expect(button.title).toBe('打开关联对话框');
  expect(host.querySelector('[aria-label^="复制"]')).toBeNull();
});
it('未提供有效复制内容时不渲染复制入口', () => {
  const host = render('邮箱', undefined, '');
  expect(host.querySelector('button')).toBeNull();
});
it('标签不复制，拖选值不复制，直接点击值才复制', async () => {
  const host = render('QQ', undefined, '10001');
  act(() => host.querySelector<HTMLElement>('.weq-profile-data-label')!.click());
  expect(copyTextToClipboard).not.toHaveBeenCalled();
  const value = host.querySelector<HTMLButtonElement>('[aria-label="复制 QQ"]')!;
  const range = document.createRange();
  range.selectNodeContents(value);
  document.getSelection()!.addRange(range);
  await act(async () => value.click());
  expect(copyTextToClipboard).not.toHaveBeenCalled();
  document.getSelection()!.removeAllRanges();
  await act(async () => value.click());
  expect(copyTextToClipboard).toHaveBeenLastCalledWith('10001', document);
  expect(host.querySelector('[role="status"]')?.textContent).toBe('已复制');
});
it('异步复制完成不会从用户当前操作处抢回焦点', async () => {
  let finish!: (ok: boolean) => void;
  vi.mocked(copyTextToClipboard).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  const host = render('QQ', undefined, '10001');
  const input = document.createElement('input');
  host.append(input);
  act(() => host.querySelector<HTMLButtonElement>('button')!.click());
  input.focus();
  await act(async () => finish(true));
  expect(document.activeElement).toBe(input);
});
