import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from './support/templateDemoData';

vi.mock('../src/renderer/src/trpc/client', () => {
  const catalog = {
    faces: [
      { id: '297', desc: '/拜谢', shortcuts: ['bx'] },
      { id: '182', desc: '/笑哭', shortcuts: ['xk'] },
    ],
    recent: [],
  };
  const proxy = (path = ''): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: path.endsWith('shortcuts') ? catalog : undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate() {}, mutateAsync: async () => undefined, isLoading: false })
            : proxy(`${path}.${String(key)}`),
    });
  return { trpc: proxy(), client: proxy() };
});
afterEach(() => vi.unstubAllGlobals());

it('只替换光标前的斜杠片段，选择不发送，取消后不会原地重弹', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onDraftChange = vi.fn();
  const onSend = vi.fn(async () => {});
  act(() =>
    root.render(
      h(ChatPane, {
        user: demo.user,
        conversation: demo.conversations[0]!,
        messages: [],
        loading: false,
        draft: '',
        onDraftChange,
        onDraftClear: vi.fn(),
        onSend,
        onBack: vi.fn(),
      }),
    ),
  );
  const editor = host.querySelector<HTMLElement>('.composer-editor')!;
  const input = (text: string, offset = text.length) =>
    act(() => {
      editor.textContent = text;
      editor.focus();
      const range = document.createRange();
      range.setStart(editor.firstChild!, offset);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
  const press = (key: string) =>
    act(() =>
      editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    );
  try {
    input('前文/bx后文', 5);
    expect(document.querySelector('[aria-label="表情候选"]')).not.toBeNull();
    press('Enter');
    expect(editor.querySelector('img')?.dataset.chatToken).toBe('[[chat:face:297]]');
    expect(editor.textContent).toBe('前文后文');
    expect(onDraftChange.mock.calls.at(-1)?.[1]).toBe('前文[[chat:face:297]]后文');
    input('/xk');
    press('Tab');
    expect(editor.querySelector('img')?.dataset.chatToken).toBe('[[chat:face:182]]');
    expect(onSend).not.toHaveBeenCalled();
    input('/');
    press('Escape');
    act(() =>
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true })),
    );
    expect(document.querySelector('[aria-label="表情候选"]')).toBeNull();
    expect(editor.textContent).toBe('/');
    input('https://example.com/笑');
    expect(document.querySelector('[aria-label="表情候选"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
