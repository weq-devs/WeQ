import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from './support/templateDemoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import {
  ContentSelectionProvider,
  useCurrentContentSelection,
} from '../src/renderer/src/state/contentSelection';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';
import { useViewState } from '../src/renderer/src/state/view';
import { copyTextToClipboard } from '../src/renderer/src/im-template/template/clipboard';

vi.mock('../src/renderer/src/im-template/template/clipboard', () => ({
  copyTextToClipboard: vi.fn(async () => true),
}));

vi.mock('../src/renderer/src/trpc/client', () => ({ client: {}, trpc: {} }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
let preferenceEpoch = 0;
let preferenceRevision = 0;

function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  preferenceEpoch += 1;
  preferenceRevision = 0;
  acceptPreferences(
    { epoch: `conversation-order-${preferenceEpoch}`, revision: 0, values: {}, records: {} },
    false,
  );
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

function freezeOrder(enabled: boolean) {
  act(() =>
    acceptPreferences(
      {
        epoch: `conversation-order-${preferenceEpoch}`,
        revision: ++preferenceRevision,
        values: { keepConversationPositionOnHover: enabled },
        records: {},
      },
      false,
    ),
  );
}

it('开启后从悬停起保持位置，摘要和未读继续更新，移出后恢复最新排序', () => {
  const f = fixture();
  try {
    freezeOrder(true);
    f.render([f.row('a', 2), f.row('b', 1)]);
    pointer(f.rows()[0]!, 'pointerover');
    f.render([f.row('a', 2), { ...f.row('b', 3), unreadCount: 9 }]);
    expect(f.ids()).toEqual(['a', 'b']);
    expect(f.rows()[1]!.textContent).toContain('9');
    pointer(f.rows()[0]!, 'pointerout', { relatedTarget: document.body });
    expect(f.ids()).toEqual(['b', 'a']);
  } finally {
    f.dispose();
  }
});

it('菜单标识原会话并持续高亮，鼠标移出后仍保持位置，关闭后恢复排序', () => {
  const f = fixture();
  try {
    freezeOrder(true);
    f.render([f.row('a', 2), f.row('b', 1)]);
    pointer(f.rows()[0]!, 'pointerover');
    act(() => f.rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.querySelector('.weq-conversation-actions-target')?.textContent).toContain('a');
    expect(f.rows()[0]!.classList.contains('is-context-target')).toBe(true);
    expect(f.onSelect).not.toHaveBeenCalled();
    pointer(f.rows()[0]!, 'pointerout', { relatedTarget: menu });
    f.render([f.row('a', 2), f.row('b', 3)]);
    expect(f.ids()).toEqual(['a', 'b']);
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(f.ids()).toEqual(['b', 'a']);
    expect(f.host.querySelector('.is-context-target')).toBeNull();
  } finally {
    f.dispose();
  }
});

it('触摸经过不冻结排序，停留时关闭设置立即恢复排序', () => {
  const f = fixture();
  try {
    freezeOrder(true);
    f.render([f.row('a', 2), f.row('b', 1)]);
    pointer(f.rows()[0]!, 'pointerover', { pointerType: 'touch' });
    f.render([f.row('a', 2), f.row('b', 3)]);
    expect(f.ids()).toEqual(['b', 'a']);
    pointer(f.rows()[0]!, 'pointerover');
    f.render([f.row('a', 4), f.row('b', 3)]);
    expect(f.ids()).toEqual(['b', 'a']);
    freezeOrder(false);
    expect(f.ids()).toEqual(['a', 'b']);
  } finally {
    f.dispose();
  }
});

it('保持期间新会话追加且不插队，删除目标后不保留旧行，失焦恢复排序', () => {
  const f = fixture();
  try {
    freezeOrder(true);
    f.render([f.row('a', 2), f.row('b', 1)]);
    pointer(f.rows()[0]!, 'pointerover');
    f.render([f.row('c', 4), f.row('a', 2), f.row('b', 3)]);
    expect(f.ids()).toEqual(['a', 'b', 'c']);
    f.render([f.row('c', 5), f.row('b', 3)]);
    expect(f.ids()).toEqual(['b', 'c']);
    act(() => window.dispatchEvent(new Event('blur')));
    expect(f.ids()).toEqual(['c', 'b']);
  } finally {
    f.dispose();
  }
});

it('默认不开启保持时菜单仍标识原对象，重排后高亮跟随稳定身份', () => {
  const f = fixture();
  try {
    f.render([f.row('a', 2), f.row('b', 1)]);
    act(() =>
      f.rows()[0]!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'F10',
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    f.render([f.row('a', 2), f.row('b', 3)]);
    expect(f.ids()).toEqual(['b', 'a']);
    expect(f.rows()[1]!.classList.contains('is-context-target')).toBe(true);
    expect(f.rows()[0]!.classList.contains('is-context-target')).toBe(false);
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toContain(
      '会话操作',
    );
    expect(f.onSelect).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it('多选菜单显示数量并高亮全部目标，不改变既有选择', () => {
  const f = fixture();
  try {
    f.render([f.row('a', 2), f.row('b', 1)]);
    click(f.rows()[0]!, { ctrlKey: true });
    click(f.rows()[1]!, { ctrlKey: true });
    act(() => f.rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    expect(document.querySelector('.weq-conversation-actions-target')?.textContent).toContain(
      '已选 2 个会话',
    );
    expect(f.host.querySelectorAll('.is-context-target')).toHaveLength(2);
    expect(f.selected()).toEqual(['a', 'b']);
    expect(f.onSelect).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it('切换账号不沿用旧会话顺序，并关闭旧账号菜单', () => {
  const f = fixture();
  const previous = useViewState.getState().openedUin;
  try {
    freezeOrder(true);
    f.render([f.row('a', 2), f.row('b', 1)]);
    pointer(f.rows()[0]!, 'pointerover');
    act(() => f.rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    f.render([f.row('a', 2), f.row('b', 3)]);
    expect(f.ids()).toEqual(['a', 'b']);
    act(() => useViewState.getState().setOpenedUin('order-other-account'));
    expect(f.ids()).toEqual(['b', 'a']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  } finally {
    f.dispose();
    useViewState.getState().setOpenedUin(previous);
  }
});

it('菜单目标被移除时关闭菜单，不转向相同位置的新会话', () => {
  const f = fixture();
  try {
    f.render([f.row('a', 2), f.row('b', 1)]);
    act(() => f.rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    f.render([f.row('b', 3)]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(f.host.querySelector('.is-context-target')).toBeNull();
    expect(f.onSelect).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it('菜单号码点击复制且不关闭菜单，反馈定时消失，失败不显示成功', async () => {
  const f = fixture();
  vi.useFakeTimers();
  try {
    f.render([f.row('10001', 2)]);
    act(() => f.rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    const copy = document.querySelector<HTMLButtonElement>('[aria-label="复制群号"]');
    expect(copy).not.toBeNull();
    await act(async () => copy!.click());
    expect(copyTextToClipboard).toHaveBeenLastCalledWith('10001', document);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(copy!.querySelector('[role="status"]')?.textContent).toBe('已复制');
    act(() => vi.advanceTimersByTime(1800));
    expect(copy!.querySelector('[role="status"]')).toBeNull();
    vi.mocked(copyTextToClipboard).mockResolvedValueOnce(false);
    await act(async () => copy!.click());
    expect(copy!.querySelector('[role="status"]')).toBeNull();
  } finally {
    f.dispose();
  }
});

it('私聊菜单复制 QQ 号原值，连续点击重新计时', async () => {
  const f = fixture();
  vi.useFakeTimers();
  try {
    const seed = createTemplateDemoData().conversations.find((row) => row.type === 'direct')!;
    f.render([{ ...seed, otherUser: { ...seed.otherUser, identityValue: '123456789' } }]);
    act(() => f.rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    const copy = document.querySelector<HTMLButtonElement>('[aria-label="复制QQ 号"]')!;
    expect(copy).not.toBeNull();
    await act(async () => copy.click());
    expect(copyTextToClipboard).toHaveBeenLastCalledWith('123456789', document);
    act(() => vi.advanceTimersByTime(1000));
    await act(async () => copy.click());
    act(() => vi.advanceTimersByTime(1000));
    expect(copy.querySelector('[role="status"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(800));
    expect(copy.querySelector('[role="status"]')).toBeNull();
  } finally {
    f.dispose();
  }
});

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
