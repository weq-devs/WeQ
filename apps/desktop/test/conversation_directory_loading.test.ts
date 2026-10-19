import { act, createElement as h, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  ContentSelectionProvider,
  useCurrentContentSelection,
} from '../src/renderer/src/state/contentSelection';

afterEach(() => vi.unstubAllGlobals());

it.each([
  { keyboard: false, initialEmpty: false },
  { keyboard: true, initialEmpty: false },
  { keyboard: false, initialEmpty: true },
])(
  '全选等待完整分页，键盘：$keyboard，首屏尚未到达：$initialEmpty',
  ({ keyboard, initialEmpty }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
    const rows = Array.from({ length: 1203 }, (_, index) => ({
      ...base,
      id: String(10000 + index),
      group: { ...base.group, id: String(10000 + index) },
    }));
    let complete: (() => void) | null = null;
    function Probe() {
      return h('output', null, JSON.stringify(useCurrentContentSelection()));
    }
    function View() {
      const [count, setCount] = useState(initialEmpty ? 0 : 400);
      const [loading, setLoading] = useState(initialEmpty);
      const busy = useRef(false);
      return h(
        ContentSelectionProvider,
        null,
        h(ConversationList, {
          conversations: rows.slice(0, count),
          activeConversationId: null,
          preferences: {},
          drafts: {},
          onSelect: vi.fn(),
          hasMore: initialEmpty && count === 0 ? undefined : count < rows.length,
          loading: initialEmpty && count === 0,
          loadingMore: loading,
          onLoadMore: () => {
            if (busy.current || count >= rows.length) return;
            busy.current = true;
            setLoading(true);
            complete = () => {
              busy.current = false;
              setLoading(false);
              setCount((value) => Math.min(value + 400, rows.length));
            };
          },
        }),
        h(Probe),
      );
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(h(View)));
      const selected = () =>
        JSON.parse(host.querySelector('output')!.textContent!).scope.ids as string[];
      if (keyboard)
        act(() =>
          host.querySelector('[data-conversation-id]')!.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'a',
              metaKey: true,
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
      else {
        act(() => host.querySelector<HTMLButtonElement>('[aria-label="多选会话"]')!.click());
        act(() => host.querySelector<HTMLButtonElement>('[aria-label="全选当前结果"]')!.click());
      }
      expect(host.textContent).toContain('正在补齐全选');
      expect(selected()).toEqual([]);
      if (!initialEmpty) expect(host.querySelector('.list-skeleton')).toBeNull();
      expect(host.querySelector('.spin')).toBeNull();
      const pageCount = initialEmpty ? 4 : 3;
      for (let page = 0; page < pageCount; page++) {
        act(() => complete!());
        if (page < pageCount - 1) expect(selected()).toEqual([]);
      }
      expect(selected()).toHaveLength(rows.length);
      expect(new Set(selected()).size).toBe(rows.length);
      expect(host.textContent).toContain('已选 1203');
      expect(host.querySelector('[data-conversation-id="10000"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it('已有会话在刷新期间不重新插入骨架，专用布局覆盖通用 grid', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(ConversationList, {
          conversations: createTemplateDemoData().conversations,
          activeConversationId: null,
          preferences: {},
          drafts: {},
          onSelect: vi.fn(),
          loading: true,
        }),
      ),
    );
    expect(host.querySelector('.list-skeleton')).toBeNull();
    expect(host.querySelector('[data-conversation-id]')).not.toBeNull();
    const css = readFileSync('src/renderer/src/styles/conversation-directory.css', 'utf8');
    expect(css).toContain('.list-stack.weq-conversation-directory');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
