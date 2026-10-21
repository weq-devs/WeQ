import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPane, MentionMenu } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { filterMentionMembers } from '../src/renderer/src/im-template/template/mentions';
import {
  focusComposerEnd,
  serializeComposer,
} from '../src/renderer/src/im-template/template/composer';
import { buildComposerSendPlan } from '../src/renderer/src/im-template/template/composerSend';
import { atAllMentionState } from '../src/renderer/src/lib/atAllMention';

const state = vi.hoisted(() => ({ value: { selectable: false, summary: '离线', detail: '离线' } }));
vi.mock('../src/renderer/src/hooks/useAtAllMention', () => ({
  useAtAllMention: () => state.value,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery' ? () => ({ data: undefined, isLoading: false }) : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('全体候选真实菜单与输入区', () => {
  it('额度在候选右侧显示，禁用行不能通过点击选择', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const demo = createTemplateDemoData();
    const conversation = demo.conversations.find((item) => item.type === 'group')!;
    const all = filterMentionMembers({ ...conversation, members: [] }, '', demo.user.id)[0]!;
    const host = document.createElement('div');
    const root = createRoot(host);
    const select = vi.fn();
    try {
      const render = async (selectable: boolean) =>
        act(async () =>
          root.render(
            createElement(MentionMenu, {
              menu: { query: '', activeIndex: 0, members: [all] },
              menuRef: { current: null },
              onActiveIndexChange: vi.fn(),
              onSelect: select,
              atAll: {
                selectable,
                summary: '个人 2 · 群 4',
                detail: '本账号剩余 2 次，群剩余 4 次',
              },
            }),
          ),
        );
      await render(false);
      const button = host.querySelector<HTMLButtonElement>('button')!;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-selected')).toBe('false');
      expect(button.querySelector('.mention-all-quota')?.textContent).toBe('个人 2 · 群 4');
      act(() => button.click());
      expect(select).not.toHaveBeenCalled();
      await render(true);
      act(() => host.querySelector<HTMLButtonElement>('button')!.click());
      expect(select).toHaveBeenCalledWith(all);
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([true, false])(
    '键盘选择遵循可用状态 %s，插入 token 而非纯文本且不发送',
    async (selectable) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('localStorage', new Storage());
      state.value = selectable
        ? atAllMentionState({
            online: true,
            data: {
              role: 'admin',
              canManage: true,
              quota: { canAtAll: true, remainCountForUin: 2, remainCountForGroup: 4 },
            },
          })
        : { selectable: false, summary: '离线', detail: '离线' };
      const demo = createTemplateDemoData();
      const source = demo.conversations.find((item) => item.type === 'group')!;
      const conversation = { ...source, members: [] };
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const send = vi.fn();
      try {
        await act(async () =>
          root.render(
            createElement(ChatPane, {
              user: demo.user,
              conversation,
              messages: [],
              loading: false,
              sendAvailable: true,
              onSend: send,
              draft: '',
              onDraftChange: vi.fn(),
              onDraftClear: vi.fn(),
              onBack: vi.fn(),
            }),
          ),
        );
        const editor = host.querySelector<HTMLElement>('.composer-editor')!;
        act(() => {
          editor.textContent = '@';
          focusComposerEnd(editor);
          editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
        });
        expect(host.querySelector('[role="listbox"]')?.textContent).toContain('全体成员');
        act(() =>
          editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
        );
        expect(send).not.toHaveBeenCalled();
        expect(Boolean(editor.querySelector('[data-weq-at-uid="all"]'))).toBe(selectable);
        if (selectable)
          expect(
            buildComposerSendPlan({
              body: serializeComposer(editor),
              locals: [],
              superStickers: new Map(),
            }),
          ).toMatchObject({
            kind: 'elements',
            elements: expect.arrayContaining([
              expect.objectContaining({ kind: 'at', all: true, atTargetUid: 'all' }),
            ]),
          });
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );
});
