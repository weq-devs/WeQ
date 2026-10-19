import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  ContentSelectionProvider,
  useContentMultiSelect,
} from '../src/renderer/src/state/contentSelection';
import { Modal } from '../src/renderer/src/components/Dialog';
import { hasActiveModal } from '../src/renderer/src/lib/overlayStack';
import type { ContentOwner } from '../src/shared/content_selection';

describe('账号工作区选择', () => {
  it('离开保留、返回恢复、另一处开始替换，换账号销毁旧选择', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let current: ReturnType<typeof useContentMultiSelect> | undefined;
    function Probe({ owner }: { owner: ContentOwner }) {
      current = useContentMultiSelect(owner);
      return createElement('span', null, [...current.selectedIds].join(','));
    }
    function state() {
      if (!current) throw new Error('组件尚未挂载');
      return current;
    }
    const chat = { kind: 'messages', container: 'group:fixture' } as const;
    const collection = { kind: 'collections', container: 'all' } as const;
    function render(owner: ContentOwner, account = 'account-a') {
      act(() =>
        root.render(
          createElement(
            ContentSelectionProvider,
            { key: account },
            createElement(Probe, { owner }),
          ),
        ),
      );
    }
    try {
      render(chat);
      act(() => state().setSelectedIds(new Set(['1', '3'])));
      render(collection);
      expect(state().selectionMode).toBe(false);
      render(chat);
      expect([...state().selectedIds]).toEqual(['1', '3']);
      render(collection);
      act(() => state().setSelectedIds(new Set(['c'])));
      render(chat);
      expect(state().selectionMode).toBe(false);
      render(collection);
      expect([...state().selectedIds]).toEqual(['c']);
      act(() => state().setSelectionMode(false));
      expect(state().selectionMode).toBe(false);
      act(() => state().setSelectedIds(new Set(['other'])));
      render(collection, 'account-b');
      expect(state().selectionMode).toBe(false);
      expect(state().selectedIds.size).toBe(0);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});

describe('工具遮罩生命周期', () => {
  it('收起遮罩保留子树状态，隐藏工具不阻断页面快捷键', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    function Content() {
      const [count, setCount] = useState(0);
      return createElement(
        'button',
        { type: 'button', onClick: () => setCount((value) => value + 1), 'data-test-tool': '' },
        String(count),
      );
    }
    const render = (open: boolean) =>
      act(() => root.render(createElement(Modal, { open }, createElement(Content))));
    try {
      render(true);
      const button = document.querySelector<HTMLButtonElement>('[data-test-tool]')!;
      act(() => button.click());
      expect(button.textContent).toBe('1');
      expect(hasActiveModal()).toBe(true);
      render(false);
      expect(hasActiveModal()).toBe(false);
      expect(document.querySelector('[data-test-tool]')).toBe(button);
      render(true);
      expect(button.textContent).toBe('1');
      expect(hasActiveModal()).toBe(true);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
