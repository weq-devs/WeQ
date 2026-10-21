import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  focusComposerEnd,
  restoreComposer,
  serializeComposer,
} from '../src/renderer/src/im-template/template/composer';
import { useDialog } from '../src/renderer/src/components/Dialog';
import {
  buildComposerSendPlan,
  buildOptimisticRender,
  type LocalMediaRef,
} from '../src/renderer/src/im-template/template/composerSend';
import { elementsToComposerText } from '../src/renderer/src/im-template/template/draftElements';

it('重发与重新编辑的表情图保留子类型和表情摘要，不变成普通大图', () => {
  for (const subType of [0, 1]) {
    const body = elementsToComposerText([
      {
        kind: 'pic',
        subType,
        summary: [subType ? '[表情]' : '[图片]'],
        width: 600,
        height: 600,
        localPreviewUrl: 'blob:fixture',
      },
    ]);
    const rendered = buildOptimisticRender({ body, locals: [], superStickers: new Map() });
    expect(rendered.elements[0]).toMatchObject({ type: 'pic', data: { subType } });
    expect(rendered.body).toBe(subType ? '[表情]' : '[图片]');
  }
});

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
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
  const conversation = demo.conversations.find((row) => row.type === 'direct')!;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const onSend = vi.fn(
    (_body: string, _locals?: LocalMediaRef[]) =>
      new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  const onDraftChange = vi.fn(),
    onDraftClear = vi.fn();
  const props = {
    user: demo.user,
    conversation,
    messages: [],
    loading: false,
    sendAvailable: true,
    draft: '第一条',
    onSend,
    onDraftChange,
    onDraftClear,
    onBack: vi.fn(),
  };
  const render = (next = {}) => act(() => root.render(h(ChatPane, { ...props, ...next })));
  render();
  const editor = () => host.querySelector<HTMLElement>('.composer-editor')!;
  act(() => focusComposerEnd(editor()));
  return {
    host,
    props,
    editor,
    render,
    onSend,
    onDraftChange,
    onDraftClear,
    finish: () => finish(),
    fail: () => fail(new Error('合成发送失败')),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
function type(editor: HTMLElement, text: string) {
  act(() => {
    restoreComposer(editor, text);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
}

describe('输入区发送交接', () => {
  it('连续图片发送失败后移除消息，释放遗留 Blob 资源而不是持续增长', async () => {
    const live = new Map<string, number>();
    let seq = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      const url = `blob:memory-${++seq}`;
      live.set(url, (blob as Blob).size);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      live.delete(url);
    });
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 1;
        naturalHeight = 1;
        onload: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const f = mount();
    try {
      type(f.editor(), '');
      for (let i = 0; i < 8; i++) {
        const file = new File([new Uint8Array(256 * 1024)], `memory-${i}.png`, {
          type: 'image/png',
        });
        const input = f.host.querySelector<HTMLInputElement>(
          'input[type="file"][accept="image/*"]',
        )!;
        await act(async () => {
          Object.defineProperty(input, 'files', { configurable: true, value: [file] });
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => f.host.querySelector<HTMLButtonElement>('.composer-send')!.click());
        await act(async () => f.fail());
        f.render({ messages: [] });
      }
      expect([...live.values()].reduce((sum, bytes) => sum + bytes, 0)).toBe(0);
    } finally {
      f.close();
    }
  });
  it('撤回的图文消息恢复图片资源和前后顺序，可再次生成图片发送计划', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );
    const f = mount();
    try {
      type(f.editor(), '');
      f.render({
        messages: [
          {
            id: 'recalled-picture',
            conversationId: f.props.conversation.id,
            senderId: f.props.user.id,
            body: '显示摘要',
            createdAt: '2026-10-21T01:00:00Z',
            recall: { revokeUid: f.props.user.id, sameSender: true, recallTs: 1 },
            qqElements: [
              { type: 'text', data: { textContent: '前文' } },
              {
                type: 'pic',
                data: {
                  fileName: 'original.gif',
                  localPath: '/fixture/nt_data/Pic/original.gif',
                  subType: 1,
                },
              },
              { type: 'text', data: { textContent: '后文' } },
            ],
          },
        ],
      });
      const marker = f.host.querySelector<HTMLButtonElement>('button.weq-msg-reedit-trigger')!;
      act(() => marker.click());
      await act(async () => marker.click());
      await act(async () => f.host.querySelector<HTMLButtonElement>('.composer-send')!.click());
      const [body, locals] = f.onSend.mock.calls[0]! as unknown as [
        string,
        import('../src/renderer/src/im-template/template/composerSend').LocalMediaRef[],
      ];
      expect(buildComposerSendPlan({ body, locals, superStickers: new Map() })).toEqual({
        kind: 'elements',
        elements: [
          { kind: 'text', textContent: '前文' },
          {
            kind: 'image',
            source: new Uint8Array([1, 2, 3]),
            fileName: 'original.gif',
            subType: 1,
          },
          { kind: 'text', textContent: '后文' },
        ],
      });
      await act(async () => f.finish());
    } finally {
      f.close();
    }
  });

  it('图片准备中切换会话或输入新稿，不覆盖；资源不可用时保留原稿', async () => {
    const f = mount();
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const message = {
      id: 'pending-picture',
      conversationId: f.props.conversation.id,
      senderId: f.props.user.id,
      body: '',
      createdAt: '2026-10-21T01:00:00Z',
      recall: { revokeUid: f.props.user.id, sameSender: true, recallTs: 1 },
      qqElements: [{ type: 'pic', data: { fileName: 'fixture.png' } }],
    };
    try {
      type(f.editor(), '');
      f.render({ messages: [message] });
      const marker = f.host.querySelector<HTMLButtonElement>('button.weq-msg-reedit-trigger')!;
      act(() => marker.click());
      act(() => marker.click());
      type(f.editor(), '新写的草稿');
      await act(async () => resolve(new Response(new Uint8Array([1]))));
      expect(serializeComposer(f.editor())).toBe('新写的草稿');
      type(f.editor(), '');
      act(() => marker.click());
      f.render({
        conversation: { ...f.props.conversation, id: 'another-conversation' },
        draft: '别的会话',
        messages: [],
      });
      await act(async () => resolve(new Response(new Uint8Array([1]))));
      expect(serializeComposer(f.editor())).toBe('别的会话');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 404 })),
      );
      f.render({ messages: [message], draft: '' });
      type(f.editor(), '');
      const failedMarker = f.host.querySelector<HTMLButtonElement>(
        'button.weq-msg-reedit-trigger',
      )!;
      act(() => failedMarker.click());
      await act(async () => failedMarker.click());
      expect(serializeComposer(f.editor())).toBe('');
      expect(f.onSend).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('失败占位提供独立移除入口，不重发也不覆盖输入草稿', async () => {
    const f = mount();
    const remove = vi.fn();
    const message = {
      id: 'optimistic-delete-me',
      conversationId: f.props.conversation.id,
      senderId: f.props.user.id,
      body: '失败原文',
      createdAt: '2026-10-21T01:00:00Z',
      optimistic: 'failed' as const,
    };
    try {
      f.render({ messages: [message], onDeleteMessage: remove });
      act(() =>
        f.host
          .querySelector('[data-message-id="optimistic-delete-me"] .message-bubble')!
          .dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
          ),
      );
      const button = [
        ...f.host.querySelectorAll<HTMLButtonElement>('.message-context-menu button'),
      ].find((button) => button.textContent === '移除失败消息');
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(remove).toHaveBeenCalledWith(message, f.props.conversation);
      expect(serializeComposer(f.editor())).toBe('第一条');
      expect(f.onSend).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('失败占位放回时间线中间时，不遮掉真实序号缺口', async () => {
    const f = mount();
    const openGap = vi.fn();
    const base = {
      conversationId: f.props.conversation.id,
      senderId: f.props.user.id,
      createdAt: '2026-10-21T01:00:00Z',
      body: '合成消息',
    };
    try {
      f.render({
        messages: [
          { ...base, id: 'real-a', msgSeq: '10' },
          { ...base, id: 'optimistic-failed-gap', optimistic: 'failed' },
          { ...base, id: 'real-b', msgSeq: '14' },
        ],
        onOpenGapMessages: openGap,
      });
      const gap = f.host.querySelector<HTMLButtonElement>('.weq-gap-band-button');
      expect(gap).not.toBeNull();
      await act(async () => gap!.click());
      expect(openGap).toHaveBeenCalledWith({
        conversation: f.props.conversation,
        previousSeq: '10',
        currentSeq: '14',
        count: 3,
      });
      expect(f.onSend).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it.each(['sending', 'sent', 'acknowledged-failure'] as const)(
    '%s 不提供失败移除入口',
    (state) => {
      const f = mount();
      const remove = vi.fn();
      try {
        f.render({
          messages: [
            {
              id: 'optimistic-protected',
              conversationId: f.props.conversation.id,
              senderId: f.props.user.id,
              body: '不能当失败删除',
              createdAt: '2026-10-21T01:00:00Z',
              optimistic: state === 'acknowledged-failure' ? 'failed' : state,
              ...(state === 'acknowledged-failure' ? { msgSeq: '42', msgRandom: '99' } : {}),
            },
          ],
          onDeleteMessage: remove,
        });
        act(() =>
          f.host
            .querySelector('[data-message-id="optimistic-protected"] .message-bubble')!
            .dispatchEvent(
              new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
            ),
        );
        expect(
          f.host.querySelector('.message-context-menu button[aria-label="移除失败消息"]'),
        ).toBeNull();
        expect(f.host.querySelector('.message-context-menu button[aria-label="删除"]')).toBeNull();
        expect(remove).not.toHaveBeenCalled();
        expect(f.onSend).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );
  it('多选可移除失败占位，混入发送成功条目时阻止整批误删', async () => {
    const f = mount();
    const remove = vi.fn();
    const base = {
      conversationId: f.props.conversation.id,
      senderId: f.props.user.id,
      createdAt: '2026-10-21T01:00:00Z',
      body: '合成占位',
      optimistic: 'failed',
    };
    try {
      f.render({
        messages: [
          { ...base, id: 'optimistic-one' },
          { ...base, id: 'optimistic-two' },
          { ...base, id: 'optimistic-confirmed', optimistic: 'sent', msgSeq: '42' },
        ],
        onDeleteMessage: remove,
      });
      act(() =>
        f.host
          .querySelector('[data-message-id="optimistic-one"] .message-bubble')!
          .dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
          ),
      );
      act(() =>
        [...f.host.querySelectorAll<HTMLButtonElement>('.message-context-menu button')]
          .find((button) => button.textContent === '多选')!
          .click(),
      );
      act(() => f.host.querySelector<HTMLElement>('[data-message-id="optimistic-two"]')!.click());
      const deletion = () =>
        f.host.querySelector<HTMLButtonElement>('button.selection-action[aria-label="删除"]')!;
      expect(deletion().disabled).toBe(false);
      act(() =>
        f.host.querySelector<HTMLElement>('[data-message-id="optimistic-confirmed"]')!.click(),
      );
      expect(deletion().disabled).toBe(true);
      act(() => deletion().click());
      expect(remove).not.toHaveBeenCalled();
      act(() =>
        f.host.querySelector<HTMLElement>('[data-message-id="optimistic-confirmed"]')!.click(),
      );
      await act(async () => deletion().click());
      expect(remove.mock.calls.map(([message]) => message.id)).toEqual([
        'optimistic-one',
        'optimistic-two',
      ]);
      expect(f.onSend).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it.each(['click', 'enter'])(
    '%s 提交立即清空并保持输入焦点，回执不清除下一条草稿',
    async (trigger) => {
      const f = mount();
      try {
        act(() => {
          if (trigger === 'click')
            f.host.querySelector<HTMLButtonElement>('.composer-send')!.click();
          else
            f.editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(f.onSend).toHaveBeenCalledWith('第一条', undefined);
        expect(serializeComposer(f.editor())).toBe('');
        expect(f.editor().getAttribute('contenteditable')).toBe('true');
        expect(document.activeElement).toBe(f.editor());
        type(f.editor(), '第二条草稿');
        act(() =>
          f.editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
        );
        expect(f.onSend).toHaveBeenCalledOnce();
        await act(async () => f.finish());
        expect(serializeComposer(f.editor())).toBe('第二条草稿');
        expect(document.activeElement).toBe(f.editor());
      } finally {
        f.close();
      }
    },
  );

  it('失败不恢复原文，也不改动等待期间输入的下一条', async () => {
    const f = mount();
    try {
      act(() => f.host.querySelector<HTMLButtonElement>('.composer-send')!.click());
      type(f.editor(), '第二条草稿');
      await act(async () => f.fail());
      expect(serializeComposer(f.editor())).toBe('第二条草稿');
      expect(f.onDraftChange).toHaveBeenLastCalledWith(f.props.conversation.id, '第二条草稿');
    } finally {
      f.close();
    }
  });

  it.each(['failed', 'recalled', 'rejected'])(
    '%s 标志分两次点击，空输入框直接重新编辑，不自动发送',
    async (status) => {
      const f = mount();
      try {
        type(f.editor(), '');
        f.render({
          messages: [
            {
              id: 'source',
              conversationId: f.props.conversation.id,
              senderId: f.props.user.id,
              body: '重新编辑的原文',
              createdAt: '2026-10-18T12:00:00Z',
              ...(status === 'recalled'
                ? { recall: { revokeUid: f.props.user.id, sameSender: true, recallTs: 1 } }
                : {
                    optimistic: status === 'failed' ? 'failed' : 'sent',
                    optimisticRejected: status === 'rejected',
                  }),
            },
          ],
        });
        const marker = f.host.querySelector<HTMLButtonElement>('button.weq-msg-reedit-trigger')!;
        expect(marker).not.toBeNull();
        act(() => marker.click());
        expect(marker.textContent).toContain('重新编辑');
        expect(serializeComposer(f.editor())).toBe('');
        await act(async () => marker.click());
        expect(serializeComposer(f.editor())).toBe('重新编辑的原文');
        expect(f.onSend).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );

  it('已有非空草稿时确认替换，取消保留；确认期间切会话不会覆盖新草稿', async () => {
    const f = mount();
    const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(false);
    try {
      const messages = [
        {
          id: 'failed',
          conversationId: f.props.conversation.id,
          senderId: f.props.user.id,
          body: '未发原文',
          createdAt: '2026-10-18T12:00:00Z',
          optimistic: 'failed',
        },
      ];
      f.render({ messages });
      const marker = f.host.querySelector<HTMLButtonElement>('button.weq-msg-reedit-trigger')!;
      act(() => marker.click());
      expect(confirm).not.toHaveBeenCalled();
      await act(async () => marker.click());
      expect(confirm).toHaveBeenCalledOnce();
      expect(serializeComposer(f.editor())).toBe('第一条');
      confirm.mockResolvedValueOnce(true);
      await act(async () => marker.click());
      expect(serializeComposer(f.editor())).toBe('未发原文');
      act(() => marker.click());
      let answer!: (value: boolean) => void;
      confirm.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      act(() => marker.click());
      f.render({
        conversation: { ...f.props.conversation, id: 'u_other' },
        draft: '新会话草稿',
        messages: [],
      });
      await act(async () => answer(true));
      expect(serializeComposer(f.editor())).toBe('新会话草稿');
    } finally {
      f.close();
    }
  });

  it('重新编辑保留提及身份和本地媒体句柄，不从显示摘要拼回正文', async () => {
    const f = mount();
    try {
      type(f.editor(), '');
      const { elementsToComposerText } = await import(
        '../src/renderer/src/im-template/template/draftElements'
      );
      const draft = elementsToComposerText([
        { kind: 'at', atTargetUid: 'u_exact', textContent: '@准确身份' },
        { kind: 'pic', localPreviewUrl: 'blob:fixture-image' },
      ]);
      const locals = [
        { key: 'blob:fixture-image', name: 'fixture.png', bytes: new Uint8Array([1, 2, 3]) },
      ];
      f.render({
        messages: [
          {
            id: 'rich-failed',
            conversationId: f.props.conversation.id,
            senderId: f.props.user.id,
            body: '摘要不能重发',
            createdAt: '2026-10-18T12:00:00Z',
            optimistic: 'failed',
            composerDraft: { body: draft, locals },
          },
        ],
      });
      const marker = f.host.querySelector<HTMLButtonElement>('button.weq-msg-reedit-trigger')!;
      act(() => marker.click());
      await act(async () => marker.click());
      const restored = serializeComposer(f.editor());
      const { composerTextToElements } = await import(
        '../src/renderer/src/im-template/template/draftElements'
      );
      const restoredElements = composerTextToElements(restored) as Array<Record<string, unknown>>;
      expect(restoredElements[0]).toEqual({
        kind: 'at',
        atTargetUid: 'u_exact',
        textContent: '@准确身份',
      });
      expect(restoredElements[1]?.localPreviewUrl).toMatch(/^blob:/);
      expect(restoredElements[1]?.localPreviewUrl).not.toBe('blob:fixture-image');
      await act(async () => f.host.querySelector<HTMLButtonElement>('.composer-send')!.click());
      const sentLocals = f.onSend.mock
        .calls[0]?.[1] as unknown as import('../src/renderer/src/im-template/template/composerSend').LocalMediaRef[];
      expect(f.onSend.mock.calls[0]?.[0]).toBe(restored);
      expect(sentLocals[0]?.key).toBe(restoredElements[1]?.localPreviewUrl);
      expect(sentLocals[0]?.bytes).toEqual(locals[0]!.bytes);
      expect(locals[0]!.key).toBe('blob:fixture-image');
      await act(async () => f.finish());
    } finally {
      f.close();
    }
  });

  it('移动端展开输入发送后回到可继续输入的紧凑框', async () => {
    const f = mount();
    try {
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="展开输入"]')!.click());
      const expanded = f.host.querySelector<HTMLElement>('.mobile-composer-expanded-editor')!;
      act(() => focusComposerEnd(expanded));
      act(() => f.host.querySelector<HTMLButtonElement>('.composer-send-expanded')!.click());
      expect(serializeComposer(f.editor())).toBe('');
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      expect(document.activeElement).toBe(f.editor());
      type(f.editor(), '移动端下一条');
      await act(async () => f.finish());
      expect(serializeComposer(f.editor())).toBe('移动端下一条');
    } finally {
      f.close();
    }
  });

  it('切换会话后，旧回执不能清空新会话草稿或抢走焦点', async () => {
    const f = mount();
    try {
      act(() => f.host.querySelector<HTMLButtonElement>('.composer-send')!.click());
      f.render({ conversation: { ...f.props.conversation, id: 'u_other' }, draft: '另一个会话' });
      const outside = document.createElement('button');
      f.host.append(outside);
      act(() => outside.focus());
      await act(async () => f.finish());
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      expect(serializeComposer(f.editor())).toBe('另一个会话');
      expect(document.activeElement).toBe(outside);
      expect(f.onDraftClear).not.toHaveBeenCalledWith('u_other');
    } finally {
      f.close();
    }
  });
});
