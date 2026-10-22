import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  composerTextToElements,
  elementsToComposerText,
} from '../src/renderer/src/im-template/template/draftElements';
import { serializeComposer } from '../src/renderer/src/im-template/template/composer';
import {
  composerClipboardFragment,
  readComposerClipboard,
  writeComposerClipboard,
} from '../src/renderer/src/im-template/template/composerClipboard';
import {
  attachmentToken,
  type ComposerAttachment,
} from '../src/renderer/src/im-template/template/composerMedia';

const systemClipboard = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('../src/renderer/src/lib/mediaExport', () => ({ exportMedia: systemClipboard }));

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

it('剪贴记录只保留选中图片的原文件，旧预览释放后可重建可发送图片', async () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
  const original: ComposerAttachment = {
    id: 'selected',
    kind: 'image',
    name: file.name,
    size: file.size,
    mime: file.type,
    url: 'blob:old-preview',
    file,
    width: 80,
    height: 60,
  };
  const editor = document.createElement('div');
  document.body.append(editor);
  editor.append('不选的前文');
  const image = document.createElement('img');
  image.src = original.url!;
  image.alt = original.name;
  image.dataset.chatToken = attachmentToken(original);
  editor.append(image, '不选的后文');
  try {
    const range = document.createRange();
    range.selectNode(image);
    window.getSelection()!.addRange(range);
    const data = new DataTransfer();
    expect(
      writeComposerClipboard(editor, data, [original, { ...original, url: 'blob:other' }]),
    ).not.toBeNull();
    const snapshot = readComposerClipboard(data)!;
    expect(snapshot.images).toHaveLength(1);
    expect(snapshot.images[0]!.file).toBe(file);
    expect(new Uint8Array(await snapshot.images[0]!.file.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(data.getData('text/html')).not.toContain('data-chat-token');
    expect(data.getData('text/html')).not.toContain('不选的');
    const restored = document.createElement('div');
    restored.append(
      composerClipboardFragment(snapshot, [{ ...original, url: 'blob:new-preview' }]),
    );
    expect(restored.querySelector('img')!.src).toBe('blob:new-preview');
    expect(composerTextToElements(serializeComposer(restored))).toEqual([
      expect.objectContaining({
        kind: 'pic',
        fileName: file.name,
        fileSize: file.size,
        localPreviewUrl: 'blob:new-preview',
        width: 80,
        height: 60,
      }),
    ]);
    data.setData(
      'text/html',
      '<div data-weq-composer-clipboard="forged"><img src="https://example.invalid/a.png"></div>',
    );
    expect(readComposerClipboard(data)).toBeNull();
  } finally {
    editor.remove();
  }
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  systemClipboard.mockClear();
});

it.each([
  [false, 'cut', false, 'pic'],
  [true, 'cut', false, 'pic'],
  [false, 'copy', false, 'pic'],
  [false, 'cut', true, 'pic'],
  [true, 'copy', true, 'pic'],
  [false, 'copy', true, 'face'],
] as const)(
  '选区剪贴往返不丢图片；展开=%s，操作=%s，单图=%s',
  async (expanded, operation, single, kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const demo = createTemplateDemoData();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const imageToken = elementsToComposerText([
      kind === 'pic'
        ? { kind, localPreviewUrl: 'blob:clipboard-fixture', fileName: 'image.png' }
        : { kind, faceId: 14, faceText: '[微笑]' },
    ]);
    const body = single ? imageToken : `前文${imageToken}后文`;
    const changed = vi.fn();
    try {
      await act(async () =>
        root.render(
          h(ChatPane, {
            user: demo.user,
            conversation: demo.conversations[0],
            messages: [],
            draft: body,
            loading: false,
            onDraftChange: changed,
            onBack: vi.fn(),
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
      const range = document.createRange();
      range.selectNodeContents(editor);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const data = new DataTransfer();
      const event = new Event(operation, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: data });
      act(() => editor.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(data.getData('text/html')).toContain('<img');
      if (single && kind === 'pic') {
        expect(systemClipboard).toHaveBeenCalledWith(
          { url: 'blob:clipboard-fixture', name: '[图片]' },
          'clipboard',
          document,
          {
            text: data.getData('text/plain'),
            html: data.getData('text/html'),
          },
        );
      } else {
        expect(systemClipboard).not.toHaveBeenCalled();
      }
      expect(serializeComposer(editor)).toBe(operation === 'cut' ? '' : body);
      if (operation === 'copy') {
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: data });
      await act(async () => editor.dispatchEvent(paste));
      expect(serializeComposer(editor)).toBe(body);
      expect(editor.querySelectorAll('img')).toHaveLength(1);
      expect(changed).toHaveBeenLastCalledWith(demo.conversations[0]!.id, body);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
