import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const host = document.createElement('div');
  const otherInput = document.createElement('input');
  document.body.append(host, otherInput);
  const root = createRoot(host);
  const props = {
    user: demo.user,
    conversation: demo.conversations[0]!,
    messages: [],
    loading: false,
    draft: '已有草稿',
    onSend: vi.fn(async () => {}),
    onDraftChange: vi.fn(),
    onDraftClear: vi.fn(),
    onBack: vi.fn(),
  };
  const render = (next: Partial<Parameters<typeof ChatPane>[0]> = {}, active = true) =>
    act(() => root.render(h(TabActivity, { active }, h(ChatPane, { ...props, ...next }))));
  return {
    host,
    otherInput,
    props,
    render,
    editor: () => host.querySelector<HTMLElement>('.composer-editor')!,
    dispose() {
      act(() => root.unmount());
      host.remove();
      otherInput.remove();
    },
  };
}

describe('进入会话自动聚焦', () => {
  it('首次进入与切换会话后聚焦输入框，光标位于恢复的草稿末尾', () => {
    const f = fixture();
    try {
      f.render();
      expect(document.activeElement).toBe(f.editor());
      expect(f.editor().textContent).toBe(f.props.draft);
      const selection = window.getSelection()!;
      expect(selection.isCollapsed).toBe(true);
      const before = document.createRange();
      before.selectNodeContents(f.editor());
      before.setEnd(selection.anchorNode!, selection.anchorOffset);
      expect(before.toString()).toBe(f.props.draft);

      act(() => f.otherInput.focus());
      f.render({ conversation: { ...f.props.conversation, id: 'another-chat' }, draft: '新草稿' });
      expect(document.activeElement).toBe(f.editor());
      expect(f.editor().textContent).toBe('新草稿');
    } finally {
      f.dispose();
    }
  });

  it('后台会话不抢焦点，切回会话时再聚焦', () => {
    const f = fixture();
    try {
      act(() => f.otherInput.focus());
      f.render({}, false);
      expect(document.activeElement).toBe(f.otherInput);
      f.render();
      expect(document.activeElement).toBe(f.editor());
    } finally {
      f.dispose();
    }
  });

  it('同一会话刷新不抢焦点，屏蔽会话不自动聚焦', () => {
    const f = fixture();
    try {
      f.render();
      act(() => f.otherInput.focus());
      f.render({ loading: true });
      expect(document.activeElement).toBe(f.otherInput);
      f.render({
        conversation: { ...f.props.conversation, id: 'blocked-chat' },
        preference: { blocked: true },
      });
      expect(document.activeElement).toBe(f.otherInput);
    } finally {
      f.dispose();
    }
  });
});
