import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ConversationSelectionToolbar } from '../src/renderer/src/components/ConversationSelectionToolbar';

it('多选工具栏支持已读、未读但不提供独立撤销按钮，操作中禁用标记', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onReadState = vi.fn();
  const props = {
    count: 2,
    allSelected: false,
    onSelectAll: vi.fn(),
    onExport: vi.fn(),
    onRoaming: vi.fn(),
    onExit: vi.fn(),
    onReadState,
  };
  const button = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  try {
    act(() => root.render(h(ConversationSelectionToolbar, props)));
    act(() => button('标为已读').click());
    act(() => button('标为未读').click());
    expect(onReadState.mock.calls).toEqual([[false], [true]]);
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
    expect(button('标为未读').disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
