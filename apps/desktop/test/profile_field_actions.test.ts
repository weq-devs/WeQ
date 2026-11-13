import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactRow } from '../src/renderer/src/components/contactProfile/ContactRow';

const cleanups: (() => void)[] = [];
function render(label: string, onActivate?: () => void) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      h(ContactRow, {
        label,
        value: '合成内容',
        copyValue: '合成内容',
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
  vi.unstubAllGlobals();
});
it.each(['QQ', 'QID', 'UID'])('只有标识字段 %s 提供点击复制', (label) => {
  const host = render(label);
  expect(host.querySelector(`[aria-label="复制 ${label}"]`)?.textContent).toBe('合成内容');
});
it.each(['昵称', '性别', '年龄', '邮箱', '公司', '个人说明', '群号', 'ID'])(
  '只读字段 %s 点值即复制（不额外渲染图标按钮）',
  (label) => {
    const host = render(label);
    const button = host.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe(`复制 ${label}`);
    expect(host.querySelector('svg')).toBeNull();
    expect(button?.textContent).toBe('合成内容');
  },
);
it('关联对话框的字段点击打开，不走复制', () => {
  const open = vi.fn();
  const host = render('学校', open);
  const button = host.querySelector<HTMLButtonElement>('button')!;
  act(() => button.click());
  expect(open).toHaveBeenCalledOnce();
  expect(button.title).toBe('打开关联对话框');
  expect(host.querySelector('[aria-label^="复制"]')).toBeNull();
});
