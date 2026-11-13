import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from './support/templateDemoData';
import { insertComposerNode } from '../src/renderer/src/im-template/template/composer';

const target = vi.hoisted(() => ({ web: false }));
vi.mock('../src/renderer/src/lib/target', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/lib/target')>()),
  get IS_WEB() {
    return target.web;
  },
}));

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

afterEach(() => {
  target.web = false;
  vi.unstubAllGlobals();
});

it('表情面板插入不抢键盘焦点，连续插入沿用更新后的光标位置', () => {
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.textContent = '前后';
  const button = document.createElement('button');
  document.body.append(editor, button);
  try {
    button.focus();
    const saved = document.createRange();
    saved.setStart(editor.firstChild!, 1);
    saved.collapse(true);
    const next = insertComposerNode(editor, document.createTextNode('甲'), saved, false);
    insertComposerNode(editor, document.createTextNode('乙'), next ?? null, false);
    expect(editor.textContent).toBe('前甲乙后');
    expect(document.activeElement).toBe(button);
  } finally {
    editor.remove();
    button.remove();
  }
});

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
  it.each([
    [390, 844, false],
    [640, 960, false],
    [390, 844, true],
    [640, 960, true],
  ] as const)('桌面端竖屏 %s × %s / Web %s 进入及返回会话自动聚焦', (width, height, web) => {
    target.web = web;
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', maxTouchPoints: 0 });
    vi.stubGlobal('innerWidth', width);
    vi.stubGlobal('innerHeight', height);
    vi.stubGlobal('matchMedia', (query: string) =>
      Object.assign(new EventTarget(), { matches: query === '(max-width: 760px)' }),
    );
    const f = fixture();
    localStorage.setItem('chat-template.layout.composerCollapsed', '1');
    try {
      act(() => f.otherInput.focus());
      f.render();
      expect(document.activeElement).toBe(f.editor());
      expect(f.editor().textContent).toBe('已有草稿');

      act(() => f.otherInput.focus());
      const next = {
        conversation: { ...f.props.conversation, id: 'desktop-portrait' },
        draft: '新草稿',
      };
      f.render(next);
      expect(document.activeElement).toBe(f.editor());
      expect(f.editor().textContent).toBe('新草稿');

      act(() => f.otherInput.focus());
      f.render({ ...next, loading: true });
      expect(document.activeElement).toBe(f.otherInput);
      f.render(next, false);
      expect(document.activeElement).toBe(f.otherInput);
      f.render(next);
      expect(document.activeElement).toBe(f.editor());
    } finally {
      f.dispose();
    }
  });

  it.each([
    ['Remote 窄横屏', 640, 320, 'WeQRemote Android', 5],
    ['Remote 手机横屏', 844, 390, 'WeQRemote iOS', 5],
    ['Remote 平板横屏', 1024, 768, 'WeQRemote iPadOS', 5],
    ['Remote 宽竖屏', 820, 1180, 'WeQRemote iPadOS', 5],
    ['手机网页横屏', 844, 390, 'Mozilla/5.0 (Linux; Android 15)', 5],
    ['iPad 桌面 UA 横屏', 1024, 768, 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', 5],
  ] as const)(
    '%s 进入、切换及返回会话不自动聚焦，手动输入仍可用',
    (_name, width, height, userAgent, maxTouchPoints) => {
      target.web = true;
      vi.stubGlobal('navigator', { userAgent, maxTouchPoints });
      vi.stubGlobal('innerWidth', width);
      vi.stubGlobal('innerHeight', height);
      vi.stubGlobal('screen', {
        width,
        height,
        orientation: Object.assign(new EventTarget(), {
          type: width > height ? 'landscape-primary' : 'portrait-primary',
        }),
      });
      vi.stubGlobal('matchMedia', (query: string) =>
        Object.assign(new EventTarget(), {
          matches: query === '(max-width: 760px)' ? width <= 760 : true,
        }),
      );
      const f = fixture();
      try {
        act(() => f.otherInput.focus());
        f.render();
        expect(document.activeElement).toBe(f.otherInput);
        expect(f.editor().textContent).toBe('已有草稿');

        act(() => {
          f.editor().focus();
          f.editor().textContent = '手动输入';
          f.editor().dispatchEvent(new InputEvent('input', { bubbles: true }));
        });
        expect(document.activeElement).toBe(f.editor());
        expect(f.props.onDraftChange).toHaveBeenLastCalledWith(f.props.conversation.id, '手动输入');

        f.render({
          conversation: { ...f.props.conversation, id: 'next-landscape' },
          draft: '新草稿',
        });
        expect(document.activeElement).not.toBe(f.editor());
        expect(f.editor().textContent).toBe('新草稿');
        act(() => f.otherInput.focus());
        f.render({}, false);
        f.render();
        expect(document.activeElement).toBe(f.otherInput);
      } finally {
        f.dispose();
      }
    },
  );

  it.each(['0', '1'])('手机输入区常驻，忽略旧收起偏好 %s 且不抢焦点', (saved) => {
    const f = fixture();
    target.web = true;
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone)', maxTouchPoints: 5 });
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    vi.stubGlobal('screen', {
      width: 390,
      height: 844,
      orientation: Object.assign(new EventTarget(), { type: 'portrait-primary' }),
    });
    vi.stubGlobal('matchMedia', (query: string) =>
      Object.assign(new EventTarget(), { matches: query === '(max-width: 760px)' }),
    );
    localStorage.setItem('chat-template.layout.composerCollapsed', saved);
    try {
      act(() => f.otherInput.focus());
      f.render();
      expect(f.host.querySelector('.chat-pane')?.classList.contains('composer-collapsed')).toBe(
        false,
      );
      expect(document.activeElement).toBe(f.otherInput);
      expect(f.editor().textContent).toBe('已有草稿');
      expect(f.host.querySelector('.mobile-composer-toggle')).toBeNull();
      expect(f.host.querySelector('.composer-toggle')).toBeNull();
      act(() => {
        f.editor().textContent = '手机上继续输入';
        f.editor().dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
      f.render({ loading: true });
      expect(f.editor().textContent).toBe('手机上继续输入');
      f.render({ conversation: { ...f.props.conversation, id: 'next-mobile' }, draft: '新草稿' });
      expect(f.host.querySelector('.chat-pane')?.classList.contains('composer-collapsed')).toBe(
        false,
      );
      expect(f.editor().textContent).toBe('新草稿');
      expect(localStorage.getItem('chat-template.layout.composerCollapsed')).toBe(saved);
      expect(document.activeElement).toBe(f.otherInput);
    } finally {
      f.dispose();
    }
  });

  it.each(['resolve', 'reject'] as const)(
    '发送迟到的 %s 不清空后续输入或其他会话草稿',
    async (outcome) => {
      const f = fixture();
      let settle: () => void = () => {};
      const send = vi.fn(
        (_body: string) =>
          new Promise<void>((resolve, reject) => {
            settle = () =>
              outcome === 'resolve' ? resolve() : reject(new Error('离线发送失败夹具'));
          }),
      );
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        f.render({ onSend: send });
        await act(async () => f.host.querySelector<HTMLButtonElement>('.composer-send')?.click());
        expect(send).toHaveBeenCalledOnce();
        expect(send.mock.calls[0]?.[0]).toBe('已有草稿');
        act(() => {
          f.editor().textContent = '发送后继续输入';
          f.editor().dispatchEvent(new InputEvent('input', { bubbles: true }));
        });
        f.render({
          onSend: send,
          conversation: { ...f.props.conversation, id: 'next-chat' },
          draft: '另一会话草稿',
        });
        const clears = f.props.onDraftClear.mock.calls.length;
        await act(async () => settle());
        expect(f.editor().textContent).toBe('另一会话草稿');
        expect(f.props.onDraftClear).toHaveBeenCalledTimes(clears);
        expect(send).toHaveBeenCalledOnce();
      } finally {
        log.mockRestore();
        f.dispose();
      }
    },
  );

  it('迟到的草稿可回填未编辑输入框，但不能覆盖用户刚输入的内容', () => {
    const f = fixture();
    try {
      f.render({ draft: '' });
      f.render({ draft: '从本机恢复的正文' });
      expect(f.editor().textContent).toBe('从本机恢复的正文');
      act(() => {
        f.editor().textContent = '用户继续输入';
        f.editor().dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
      f.render({ draft: '迟到的 QQ 旧正文' });
      expect(f.editor().textContent).toBe('用户继续输入');
    } finally {
      f.dispose();
    }
  });

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
