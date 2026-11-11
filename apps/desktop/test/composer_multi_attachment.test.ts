import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  restoreComposer,
  serializeComposer,
} from '../src/renderer/src/im-template/template/composer';
import {
  buildComposerSendPlan,
  type LocalMediaRef,
} from '../src/renderer/src/im-template/template/composerSend';
import {
  attachmentToken,
  MAX_COMPOSER_ATTACHMENTS,
  type ComposerAttachment,
} from '../src/renderer/src/im-template/template/composerMedia';
import { composerTextToElements } from '../src/renderer/src/im-template/template/draftElements';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn() })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/lib/composerDraftMedia', async (original) => ({
  ...(await original<typeof import('../src/renderer/src/lib/composerDraftMedia')>()),
  preserveComposerImages: async () => {},
}));
vi.mock('../src/renderer/src/im-template/template/composerMedia', async (original) => {
  const actual =
    await original<typeof import('../src/renderer/src/im-template/template/composerMedia')>();
  return {
    ...actual,
    createAttachment: vi.fn(
      async (file: File, sendAs?: 'file'): Promise<ComposerAttachment> => ({
        id: actual.createMediaId(),
        kind: sendAs ?? actual.attachmentKindOf(file),
        name: file.name,
        size: file.size,
        mime: file.type,
        url:
          sendAs === 'file' || actual.attachmentKindOf(file) === 'file'
            ? null
            : `blob:${actual.createMediaId()}`,
        file,
      }),
    ),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const demo = createTemplateDemoData();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onSend = vi.fn(async (_body: string, _locals?: LocalMediaRef[]) => {});
  const props = {
    user: demo.user,
    conversation: demo.conversations.find((row) => row.type === 'direct')!,
    messages: [],
    loading: false,
    sendAvailable: true,
    draft: '',
    onSend,
    onDraftChange: vi.fn(),
    onDraftClear: vi.fn(),
    onBack: vi.fn(),
  };
  const render = (next = {}) => act(() => root.render(h(ChatPane, { ...props, ...next })));
  render();
  const editor = () => host.querySelector<HTMLElement>('.composer-editor')!;
  const add = async (files: File[], picker = false) => {
    await act(async () => {
      if (picker) {
        const input = host.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
        Object.defineProperty(input, 'files', { configurable: true, value: files });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } });
        host.querySelector('.composer')!.dispatchEvent(event);
      }
    });
  };
  const send = () =>
    act(async () => {
      host.querySelector<HTMLButtonElement>('.composer-send')!.click();
    });
  return {
    host,
    props,
    editor,
    add,
    send,
    onSend,
    render,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('文件选择器支持多选、继续添加和逐项移除，同名同大小文件保留各自本体', async () => {
  const f = mount();
  try {
    const first = new File(['aaa'], 'same.txt'),
      second = new File(['bbb'], 'same.txt');
    expect(
      f.host.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!.multiple,
    ).toBe(true);
    await f.add([first, second], true);
    await f.add([new File(['remove'], 'remove.txt')], true);
    expect(f.host.querySelectorAll('.composer-media-tray .composer-single-card')).toHaveLength(3);
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="移除 remove.txt"]')!.click());
    await f.send();
    expect(f.onSend).toHaveBeenCalledTimes(2);
    expect(f.onSend.mock.calls.map(([, locals]) => locals?.length)).toEqual([1, 1]);
    const plans = f.onSend.mock.calls.map(([body, locals]) =>
      buildComposerSendPlan({ body, locals: locals ?? [], superStickers: new Map() }),
    );
    expect(plans).toEqual([
      { kind: 'file', fileName: first.name, file: first },
      { kind: 'file', fileName: second.name, file: second },
    ]);
    expect(f.host.querySelector('.composer-media-tray')).toBeNull();
  } finally {
    f.close();
  }
});

it('混合图片、文件和视频一次提交，不忽略图片；某项失败仍交接其余项', async () => {
  const f = mount();
  try {
    await f.add([
      new File(['image'], 'pic.png', { type: 'image/png' }),
      new File(['doc'], 'doc.txt'),
      new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
    ]);
    expect(f.editor().querySelectorAll('img')).toHaveLength(1);
    expect(f.editor().classList.contains('composer-row-hidden')).toBe(false);
    expect(f.host.querySelectorAll('.composer-media-tray .composer-single-card')).toHaveLength(2);
    f.onSend.mockRejectedValueOnce(new Error('合成失败'));
    await f.send();
    expect(f.onSend).toHaveBeenCalledTimes(3);
    expect(
      f.onSend.mock.calls.map(([body]) =>
        composerTextToElements(body).map((value) => (value as { kind: string }).kind),
      ),
    ).toEqual([['pic'], ['file'], ['video']]);
    expect(serializeComposer(f.editor())).toBe('');
  } finally {
    f.close();
  }
});

it('等待上一项异步交接后再提交下一项，失败后仍按顺序继续且不清除新输入', async () => {
  const f = mount();
  try {
    await f.add([new File(['a'], 'first.txt'), new File(['b'], 'second.txt')], true);
    let reject!: (error: Error) => void;
    f.onSend.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    act(() => f.host.querySelector<HTMLButtonElement>('.composer-send')!.click());
    await act(async () => {});
    expect(f.onSend).toHaveBeenCalledOnce();
    act(() => {
      restoreComposer(f.editor(), '下一条草稿');
      f.editor().dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    await act(async () => reject(new Error('第一项交接失败')));
    expect(f.onSend).toHaveBeenCalledTimes(2);
    expect(
      f.onSend.mock.calls.map(
        ([body]) => (composerTextToElements(body)[0] as { fileName: string }).fileName,
      ),
    ).toEqual(['first.txt', 'second.txt']);
    expect(serializeComposer(f.editor())).toBe('下一条草稿');
  } finally {
    f.close();
  }
});

it('连续添加共用数量上限，超大项跳过后仍接收可用文件', async () => {
  const f = mount();
  try {
    await f.add(
      Array.from({ length: MAX_COMPOSER_ATTACHMENTS - 1 }, (_, i) => new File(['a'], `${i}.txt`)),
      true,
    );
    const huge = new File(['a'], 'huge.bin');
    Object.defineProperty(huge, 'size', { value: 101 * 1024 * 1024 });
    await f.add([huge, new File(['a'], 'last.txt'), new File(['a'], 'overflow.txt')], true);
    expect(f.host.querySelectorAll('.composer-media-tray .composer-single-card')).toHaveLength(
      MAX_COMPOSER_ATTACHMENTS,
    );
    await f.add([new File(['a'], 'extra.txt')], true);
    expect(f.host.querySelector('.composer-attachment-error')?.textContent).toContain(
      String(MAX_COMPOSER_ATTACHMENTS),
    );
    await f.send();
    expect(f.onSend).toHaveBeenCalledTimes(MAX_COMPOSER_ATTACHMENTS);
  } finally {
    f.close();
  }
});

it('读取媒体期间切会话不向新会话交接，也不清除新草稿', async () => {
  const f = mount();
  try {
    const file = new File(['video'], 'slow.mp4', { type: 'video/mp4' });
    let finish!: (value: ArrayBuffer) => void;
    Object.defineProperty(file, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
    });
    await f.add([file]);
    act(() => f.host.querySelector<HTMLButtonElement>('.composer-send')!.click());
    f.render({ conversation: { ...f.props.conversation, id: 'another' }, draft: '新会话草稿' });
    await act(async () => finish(new ArrayBuffer(4)));
    expect(f.onSend).not.toHaveBeenCalled();
    expect(serializeComposer(f.editor())).toBe('新会话草稿');
  } finally {
    f.close();
  }
});

it('20 张图片的完整 token 不会被正文 4000 字符限制截断，文字仍有上限', () => {
  const body = Array.from({ length: MAX_COMPOSER_ATTACHMENTS }, (_, i) =>
    attachmentToken({
      id: String(i),
      kind: 'image',
      file: new File(['a'], `image-${i}.png`),
      name: `image-${i}.png`,
      size: 1,
      mime: 'image/png',
      url: `blob:http://localhost/00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      width: 100,
      height: 100,
    }),
  ).join('');
  expect(body.length).toBeGreaterThan(4000);
  const editor = document.createElement('div');
  restoreComposer(editor, `正文${body}`);
  expect(serializeComposer(editor)).toBe(`正文${body}`);
  restoreComposer(editor, `${'x'.repeat(4100)}${body}`);
  expect(serializeComposer(editor)).toBe(`${'x'.repeat(4000)}${body}`);
});
