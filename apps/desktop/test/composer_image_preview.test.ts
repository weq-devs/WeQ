import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { elementsToComposerText } from '../src/renderer/src/im-template/template/draftElements';
import { serializeComposer } from '../src/renderer/src/im-template/template/composer';

const state = vi.hoisted(() => ({
  open: vi.fn(
    (_src: string, _alt?: string, _ocr?: unknown, _document?: Document, _closed?: () => void) => {},
  ),
}));
vi.mock('../src/renderer/src/components/ImageLightbox', () => ({ openLightbox: state.open }));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn() })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.open.mockClear();
});

it.each([false, true])(
  '输入框图片预览不改草稿，关闭后恢复光标；展开输入框=%s',
  async (expanded) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const demo = createTemplateDemoData();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draft = `前文${elementsToComposerText([{ kind: 'pic', localPreviewUrl: 'blob:composer-preview', fileName: 'fixture.png', width: 600, height: 400 }])}后文`;
    const send = vi.fn();
    try {
      await act(async () =>
        root.render(
          h(ChatPane, {
            user: demo.user,
            conversation: demo.conversations[0],
            messages: [],
            draft,
            loading: false,
            onDraftChange: vi.fn(),
            onBack: vi.fn(),
            onSend: send,
          }),
        ),
      );
      if (expanded) {
        await act(async () => {
          host.querySelector<HTMLButtonElement>('.mobile-composer-expand-button')!.click();
          await new Promise((resolve) => setTimeout(resolve, 40));
        });
      }
      const editor = host.querySelector<HTMLDivElement>(
        expanded ? '.mobile-composer-expanded-editor' : '.composer-editor',
      )!;
      const image = editor.querySelector<HTMLImageElement>('img')!;
      const range = document.createRange();
      range.setStart(editor.firstChild!, 1);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      act(() => editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
      const before = serializeComposer(editor);
      act(() =>
        image.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
        ),
      );
      act(() => image.click());
      expect(state.open).toHaveBeenCalledOnce();
      expect(state.open.mock.calls[0]?.slice(0, 4)).toEqual([
        'blob:composer-preview',
        '[图片]',
        null,
        document,
      ]);
      expect(serializeComposer(editor)).toBe(before);
      expect(send).not.toHaveBeenCalled();
      selection.removeAllRanges();
      await act(async () => {
        state.open.mock.calls[0]?.[4]?.();
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      expect(document.activeElement).toBe(editor);
      expect(selection.anchorNode).toBe(editor.firstChild);
      expect(selection.anchorOffset).toBe(1);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
