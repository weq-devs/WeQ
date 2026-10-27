import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AddGroupMembersModal } from '../src/renderer/src/views/agentlab/AddGroupMembersModal';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

it('选择期间成员状态刷新后自动锁定，不把已入群的选择再次提交', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const onAdd = vi.fn(async () => ({ addedIds: [] }));
  const props = {
    groupName: '合成群',
    personas: [
      { id: 'a', name: '原成员' },
      { id: 'b', name: '新成员' },
    ],
    onAdd,
    onClose: vi.fn(),
  };
  const checkbox = () => document.querySelector<HTMLInputElement>('[aria-label="新成员"]')!;
  try {
    act(() => root.render(h(AddGroupMembersModal, { ...props, memberIds: ['a'] })));
    act(() => checkbox().click());
    expect(checkbox().checked).toBe(true);
    act(() => root.render(h(AddGroupMembersModal, { ...props, memberIds: ['a', 'b'] })));
    expect(checkbox().checked).toBe(true);
    expect(checkbox().disabled).toBe(true);
    const add = [
      ...document.querySelectorAll<HTMLButtonElement>('.weq-clone-add-modal button'),
    ].find((button) => button.textContent === '添加（0）')!;
    expect(add.disabled).toBe(true);
    act(() => add.click());
    expect(onAdd).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});

it('成员状态尚未加载或加载失败时不允许勾选提交，空列表明确提示', () => {
  const root = createRoot(document.createElement('div'));
  const props = {
    groupName: '合成群',
    personas: [{ id: 'a', name: '合成成员' }],
    memberIds: [],
    onAdd: vi.fn(async () => ({ addedIds: [] })),
    onClose: vi.fn(),
  };
  try {
    act(() => root.render(h(AddGroupMembersModal, { ...props, loading: true })));
    expect(document.querySelector('.weq-clone-add-list')?.textContent).toContain('正在加载');
    expect(document.querySelector('.weq-clone-add-list input')).toBeNull();
    act(() => root.render(h(AddGroupMembersModal, { ...props, loadError: '合成加载失败' })));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('合成加载失败');
    act(() => root.render(h(AddGroupMembersModal, { ...props, personas: [] })));
    expect(document.querySelector('.weq-clone-add-list')?.textContent).toContain('还没有克隆体');
    expect(props.onAdd).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
