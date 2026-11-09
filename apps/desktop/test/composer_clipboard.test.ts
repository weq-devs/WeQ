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
import { originalMessageClipboard } from '../src/renderer/src/lib/originalMessageClipboard';
import * as originalClipboard from '../src/renderer/src/lib/originalMessageClipboard';

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

it('整条引用与卡片粘贴为原始草稿，引用显示在引用条，粘贴不会发送或替换现有正文', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const conversation = demo.conversations[0]!;
  const card = {
    type: 'ark',
    data: { arkData: '{"app":"synthetic.app","meta":{"news":{"title":"合成卡片"}}}' },
  };
  const value = originalMessageClipboard(
    [
      {
        createdAt: '2026-11-09T10:00:00+08:00',
        body: '答复',
        qqElements: [
          {
            type: 'reply',
            data: {
              origMsgSeq: 17,
              origSenderName: '原作者',
              origElements: [{ type: 'text', data: { textContent: '原话' } }],
            },
          },
          { type: 'text', data: { textContent: '答复' } },
          card,
        ],
      },
    ],
    { account: demo.user.identityValue, conversation: conversation.id },
    { text: '> 原话\n答复\n[卡片]', html: '' },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn();
  try {
    await act(async () =>
      root.render(
        h(ChatPane, {
          user: demo.user,
          conversation,
          messages: [],
          draft: '已有正文',
          loading: false,
          onDraftChange: vi.fn(),
          onBack: vi.fn(),
          onSend: send,
        }),
      ),
    );
    const editor = host.querySelector<HTMLDivElement>('.composer-editor')!;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const data = new DataTransfer();
    data.setData('text/plain', value.text);
    data.setData('text/html', value.html);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: data });
    await act(async () => editor.dispatchEvent(paste));
    expect(paste.defaultPrevented).toBe(true);
    expect(composerTextToElements(serializeComposer(editor))).toEqual([
      { kind: 'text', textContent: '已有正文答复' },
      { kind: 'ark', arkData: card.data.arkData },
    ]);
    expect(host.querySelector('[aria-label="待发送的引用"]')?.textContent).toContain('原作者原话');
    expect(send).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('异步粘贴期间继续输入不会覆盖新正文，未插入的预览会释放', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const conversation = demo.conversations[0]!;
  const value = originalMessageClipboard(
    [{ body: '复制内容', createdAt: conversation.updatedAt }],
    { account: demo.user.identityValue, conversation: conversation.id },
    { text: '复制内容', html: '' },
  );
  let finish!: (
    draft: Awaited<ReturnType<typeof originalClipboard.prepareOriginalMessageClipboard>>,
  ) => void;
  vi.spyOn(originalClipboard, 'prepareOriginalMessageClipboard').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(ChatPane, {
          user: demo.user,
          conversation,
          messages: [],
          draft: '',
          loading: false,
          onDraftChange: vi.fn(),
          onBack: vi.fn(),
        }),
      ),
    );
    const editor = host.querySelector<HTMLDivElement>('.composer-editor')!;
    const data = new DataTransfer();
    data.setData('text/plain', value.text);
    data.setData('text/html', value.html);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: data });
    await act(async () => editor.dispatchEvent(paste));
    await act(async () => {
      editor.textContent = '后续输入';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      finish({ body: '复制内容', locals: [], objectUrls: ['blob:unused-paste'] });
    });
    expect(serializeComposer(editor)).toBe('后续输入');
    expect(revoke).toHaveBeenCalledWith('blob:unused-paste');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
