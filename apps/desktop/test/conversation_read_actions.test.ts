import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ConversationSelectionToolbar } from '../src/renderer/src/components/ConversationSelectionToolbar';

it('底部工具栏只提供漫游、导出、名单和已读，操作中禁用标记', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onReadState = vi.fn();
  const props = {
    onExport: vi.fn(),
    onRoaming: vi.fn(),
    onRoster: vi.fn(),
    onReadState,
  };
  const button = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  try {
    act(() => root.render(h(ConversationSelectionToolbar, props)));
    act(() => button('标为已读').click());
    expect(onReadState).toHaveBeenCalledOnce();
    expect(button('标为未读')).toBeNull();
    expect(
      [...host.querySelectorAll('button')].map((node) => node.getAttribute('aria-label')),
    ).toEqual(['拉取所选会话漫游消息', '导出所选会话', '导出名单', '标为已读']);
    expect(button('撤销标记')).toBeNull();
    act(() =>
      root.render(
        h(ConversationSelectionToolbar, {
          ...props,
          readStateReason: '正在更新标记',
        }),
      ),
    );
    expect(button('标为已读').disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
