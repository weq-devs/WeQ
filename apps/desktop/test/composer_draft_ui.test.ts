import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { elementToToken } from '../src/renderer/src/im-template/template/draftElements';
import {
  restoreComposer,
  serializeComposer,
} from '../src/renderer/src/im-template/template/composer';

const state = vi.hoisted(() => ({ restore: vi.fn() }));
vi.mock('../src/renderer/src/lib/composerDraftMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/lib/composerDraftMedia')>()),
  restoreComposerImages: state.restore,
}));
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
  state.restore.mockReset();
  vi.unstubAllGlobals();
});

async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  let finish = () => {};
  let fail = (_error: Error) => {};
  const token = elementToToken({
    kind: 'pic',
    localDraftAssetId: 'image-id',
    localPreviewUrl: 'blob:old',
    fileName: 'image.png',
  });
  const restoredToken = elementToToken({
    kind: 'pic',
    localDraftAssetId: 'image-id',
    localPreviewUrl: 'blob:restored',
    fileName: 'image.png',
  });
  state.restore.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        fail = reject;
        finish = () =>
          resolve({
            images: [
              {
                id: 'image-id',
                draftAssetId: 'image-id',
                kind: 'image',
                file: new File(['pixels'], 'image.png'),
                name: 'image.png',
                size: 6,
                mime: 'image/png',
                url: 'blob:restored',
              },
            ],
            rewrite: (body: string) => body.replace(token, restoredToken),
          });
      }),
  );
  const demo = createTemplateDemoData();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props = {
    user: demo.user,
    conversation: demo.conversations[0]!,
    messages: [],
    loading: false,
    draft: `原稿${token}`,
    onSend: vi.fn(async () => {}),
    onDraftChange: vi.fn(),
    onDraftClear: vi.fn(),
    onBack: vi.fn(),
  };
  const render = async (next = {}) =>
    act(async () => root.render(createElement(ChatPane, { ...props, ...next })));
  await render();
  const editor = () => host.querySelector<HTMLElement>('.composer-editor')!;
  return {
    props,
    render,
    editor,
    token,
    host,
    finish: async () => act(async () => finish()),
    fail: async () => act(async () => fail(new Error('missing fixture'))),
    dispose: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

it('图片迟到恢复保留用户续写，恢复后不自动发送', async () => {
  const f = await fixture();
  try {
    expect(f.host.querySelector<HTMLButtonElement>('.composer-send')!.disabled).toBe(true);
    act(() => {
      restoreComposer(f.editor(), `原稿${f.token}用户续写`);
      f.editor().dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    await f.finish();
    expect(serializeComposer(f.editor())).toContain('用户续写');
    expect(f.editor().querySelector('img')?.src).toBe('blob:restored');
    expect(f.props.onSend).not.toHaveBeenCalled();
    expect(f.host.querySelector<HTMLButtonElement>('.composer-send')!.disabled).toBe(false);
  } finally {
    await f.dispose();
  }
});

it('切换会话后旧图片恢复不能回填或覆盖新会话', async () => {
  const f = await fixture();
  try {
    await f.render({
      conversation: { ...f.props.conversation, id: 'other-chat' },
      draft: '另一会话的正文',
    });
    await f.finish();
    expect(serializeComposer(f.editor())).toBe('另一会话的正文');
    expect(f.editor().querySelector('img')).toBeNull();
    expect(f.props.onSend).not.toHaveBeenCalled();
  } finally {
    await f.dispose();
  }
});

it('图片恢复失败不发送坏占位，用户移除图片后仍可继续输入和发送文字', async () => {
  const f = await fixture();
  try {
    await f.fail();
    expect(f.host.querySelector<HTMLButtonElement>('.composer-send')!.disabled).toBe(true);
    act(() => {
      restoreComposer(f.editor(), '只保留文字');
      f.editor().dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    expect(f.host.querySelector<HTMLButtonElement>('.composer-send')!.disabled).toBe(false);
    expect(f.props.onSend).not.toHaveBeenCalled();
  } finally {
    await f.dispose();
  }
});
