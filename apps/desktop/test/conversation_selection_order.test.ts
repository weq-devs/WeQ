import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import {
  ContentSelectionProvider,
  useCurrentContentSelection,
} from '../src/renderer/src/state/contentSelection';

vi.mock('../src/renderer/src/trpc/client', () => ({ client: {}, trpc: {} }));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
  const row = (id: string, day: number): Conversation => ({
    ...base,
    id,
    updatedAt: `2030-01-${String(day).padStart(2, '0')}T00:00:00Z`,
    lastMessage: null,
    unreadCount: 0,
    preference: { pinned: false, muted: false, blocked: false },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onSelect = vi.fn();
  function SelectionProbe() {
    return h('output', null, JSON.stringify(useCurrentContentSelection()));
  }
  return {
    host,
    row,
    onSelect,
    render(rows: Conversation[]) {
      act(() =>
        root.render(
          h(
            ContentSelectionProvider,
            null,
            h(ConversationList, {
              conversations: rows,
              activeConversationId: null,
              preferences: {},
              drafts: {},
              onSelect,
            }),
            h(SelectionProbe),
          ),
        ),
      );
    },
    rows: () => [...host.querySelectorAll<HTMLButtonElement>('[data-conversation-id]')],
    ids: () =>
      [...host.querySelectorAll<HTMLElement>('[data-conversation-id]')].map(
        (element) => element.dataset.conversationId,
      ),
    selected: () => JSON.parse(host.querySelector('output')!.textContent!).scope.ids as string[],
    dispose() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function pointer(target: Element, type: string, options: PointerEventInit = {}) {
  act(() =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        pointerId: 1,
        isPrimary: true,
        button: 0,
        ...options,
      }),
    ),
  );
}

function click(target: Element, options: MouseEventInit = {}) {
  act(() =>
    target.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...options }),
    ),
  );
}

it.each(['row', 'ancestor'] as const)(
  '重排继续立即生效，尾随 click 落在 %s 时仍打开按下的会话',
  (target) => {
    const f = fixture();
    try {
      f.render([f.row('a', 2), f.row('b', 1)]);
      pointer(f.rows()[0]!, 'pointerdown');
      f.render([f.row('a', 2), { ...f.row('b', 3), unreadCount: 8 }]);
      expect(f.ids()).toEqual(['b', 'a']);
      expect(f.rows()[0]!.textContent).toContain('8');
      pointer(f.rows()[0]!, 'pointerup');
      click(target === 'row' ? f.rows()[0]! : f.rows()[0]!.parentElement!.parentElement!);
      expect(f.onSelect.mock.calls.map(([id]) => id)).toEqual(['a']);
      expect(f.ids()).toEqual(['b', 'a']);
    } finally {
      f.dispose();
    }
  },
);

it('鼠标悬停不影响排序，没有重排的普通点击只打开一次', () => {
  const f = fixture();
  try {
    f.render([f.row('a', 2), f.row('b', 1)]);
    pointer(f.rows()[0]!, 'pointerover');
    f.render([f.row('a', 2), f.row('b', 3)]);
    expect(f.ids()).toEqual(['b', 'a']);
    pointer(f.rows()[0]!, 'pointerdown');
    pointer(f.rows()[0]!, 'pointerup');
    click(f.rows()[0]!);
    expect(f.onSelect.mock.calls.map(([id]) => id)).toEqual(['b']);
  } finally {
    f.dispose();
  }
});

it('重排移动了按下节点，浏览器省略 click 时也能在松开后打开原会话', () => {
  const f = fixture();
  try {
    f.render([f.row('a', 2), f.row('b', 1)]);
    pointer(f.rows()[0]!, 'pointerdown');
    f.render([f.row('a', 2), f.row('b', 3)]);
    pointer(f.rows()[0]!, 'pointerup');
    expect(f.onSelect.mock.calls.map(([id]) => id)).toEqual(['a']);
    expect(f.ids()).toEqual(['b', 'a']);
  } finally {
    f.dispose();
  }
});

it('没有重排时，跨到其他行松开不额外触发会话选择', () => {
  const f = fixture();
  try {
    f.render([f.row('a', 2), f.row('b', 1)]);
    pointer(f.rows()[0]!, 'pointerdown');
    pointer(f.rows()[1]!, 'pointerup');
    click(f.rows()[0]!.parentElement!.parentElement!);
    expect(f.onSelect).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it.each(['pointercancel', 'scroll', 'move', 'removed'] as const)(
  '%s 后不把公共祖先上的 click 误当作原会话点击',
  (reason) => {
    const f = fixture();
    try {
      f.render([f.row('a', 2), f.row('b', 1)]);
      pointer(f.rows()[0]!, 'pointerdown', { pointerType: 'touch' });
      f.render(reason === 'removed' ? [f.row('b', 3)] : [f.row('a', 2), f.row('b', 3)]);
      if (reason === 'pointercancel') pointer(f.rows()[0]!, 'pointercancel');
      if (reason === 'scroll')
        act(() => f.rows()[0]!.parentElement!.dispatchEvent(new Event('scroll')));
      if (reason === 'move') pointer(document.body, 'pointermove', { clientY: 80 });
      click(f.rows()[0]!.parentElement!.parentElement!);
      expect(f.onSelect).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  },
);

it('触摸轻点按稳定 ID 打开，下一次按压不会复用上次目标', () => {
  const f = fixture();
  try {
    f.render([f.row('a', 2), f.row('b', 1)]);
    pointer(f.rows()[0]!, 'pointerdown', { pointerType: 'touch' });
    f.render([f.row('a', 2), f.row('b', 3)]);
    pointer(f.rows()[0]!, 'pointerup', { pointerType: 'touch' });
    click(f.rows()[0]!);
    pointer(f.rows()[0]!, 'pointerdown');
    click(f.rows()[0]!);
    expect(f.onSelect.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  } finally {
    f.dispose();
  }
});

it('键盘点击不被未完成的指针目标覆盖，修饰键仍交给多选', () => {
  const f = fixture();
  try {
    f.render([f.row('a', 2), f.row('b', 1)]);
    pointer(f.rows()[0]!, 'pointerdown');
    f.render([f.row('a', 2), f.row('b', 3)]);
    click(f.rows()[0]!, { detail: 0 });
    expect(f.onSelect.mock.calls.map(([id]) => id)).toEqual(['b']);
    pointer(f.rows()[1]!, 'pointerdown', { ctrlKey: true });
    click(f.rows()[1]!, { ctrlKey: true });
    expect(f.selected()).toEqual(['a']);
    expect(f.onSelect).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

it('多指触摸不把次指当作新的会话点击目标', () => {
  const f = fixture();
  try {
    f.render([f.row('a', 2), f.row('b', 1)]);
    pointer(f.rows()[0]!, 'pointerdown', { pointerType: 'touch' });
    pointer(f.rows()[1]!, 'pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false });
    f.render([f.row('a', 2), f.row('b', 3)]);
    pointer(f.rows()[0]!, 'pointerup', { pointerType: 'touch', pointerId: 2, isPrimary: false });
    click(f.rows()[0]!.parentElement!.parentElement!);
    expect(f.onSelect).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});
