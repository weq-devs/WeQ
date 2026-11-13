import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { expect, it, vi } from 'vitest';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';

vi.mock('../src/renderer/src/trpc/client', () => ({ client: {}, trpc: {} }));

it('展开搜索即隐藏会话日历，退出搜索后恢复可用入口', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calendar = vi.fn();
  const button = (label: string) =>
    host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  try {
    act(() =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(
            ConversationDirectoryContext.Provider,
            {
              value: {
                virtual: [],
                onVirtual: vi.fn(),
                onCreate: vi.fn(),
                onCalendar: calendar,
              },
            },
            h(ConversationList, {
              conversations: [],
              activeConversationId: null,
              preferences: {},
              drafts: {},
              onSelect: vi.fn(),
            }),
          ),
        ),
      ),
    );
    expect(button('会话日历')).not.toBeNull();
    for (const exit of ['button', 'escape']) {
      act(() => button('搜索会话')!.click());
      const input = host.querySelector<HTMLInputElement>('[aria-label="搜索会话名称或号码"]')!;
      expect(input).not.toBeNull();
      expect(input.value).toBe('');
      expect(button('会话日历')).toBeNull();
      act(() => {
        if (exit === 'button') button('退出搜索会话')!.click();
        else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(button('会话日历')).not.toBeNull();
    }
    act(() => button('会话日历')!.click());
    expect(calendar).toHaveBeenCalledOnce();
    expect(calendar).toHaveBeenCalledWith('');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
