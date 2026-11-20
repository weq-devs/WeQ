import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from './support/templateDemoData';
import { elementToToken } from '../src/renderer/src/im-template/template/draftElements';
import {
  restoreComposer,
  serializeComposer,
} from '../src/renderer/src/im-template/template/composer.shared';

const state = vi.hoisted(() => ({ restore: vi.fn() }));
vi.mock('../src/renderer/src/lib/composerDraftMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/lib/composerDraftMedia')>()),
  restoreComposerImages: state.restore,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'getSettings'
          ? {
              useQuery: () => ({
                data: { voiceTranscribe: { ttsProviders: [{ id: 'fixture', name: '服务商' }] } },
              }),
            }
          : key === 'synthesizeSpeech'
            ? {
                useMutation: () => ({
                  mutateAsync: async () => ({ format: 'wav', audioBase64: 'AQI=' }),
                }),
              }
            : key === 'useQuery'
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

it('TTS 和 AI 声聊同步文字草稿，切回正文保留内联图片', async () => {
  const f = await fixture();
  try {
    await f.finish();
    const voice = f.host.querySelector<HTMLButtonElement>('button[aria-label="语音"]')!;
    const selectMode = (mode: string) => {
      const button = [...f.host.querySelectorAll<HTMLButtonElement>('.voice-panel button')].find(
        (item) => item.textContent?.trim() === mode,
      )!;
      act(() => button.click());
    };
    act(() => voice.click());
    selectMode('TTS');
    const input = f.host.querySelector<HTMLTextAreaElement>('.voice-panel textarea')!;
    expect(input.value).toBe('原稿');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, '修改草稿');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    selectMode('AI 声聊');
    expect(f.host.querySelector('.voice-panel textarea')).toBe(input);
    expect(input.value).toBe('修改草稿');
    act(() => voice.click());
    const saved = serializeComposer(f.editor());
    expect(saved).toContain('修改草稿');
    expect(f.editor().querySelector('img')?.src).toBe('blob:restored');
    expect(f.props.onDraftChange).toHaveBeenLastCalledWith(f.props.conversation.id, saved);
    expect(f.props.onSend).not.toHaveBeenCalled();
  } finally {
    await f.dispose();
  }
});

it('点外面保留语音区，切换会话默认收起并保留各自的合成草稿', async () => {
  const f = await fixture();
  try {
    const voice = () => f.host.querySelector<HTMLButtonElement>('button[aria-label="语音"]')!;
    act(() => voice().click());
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(voice().getAttribute('aria-expanded')).toBe('true');
    await f.render({
      conversation: { ...f.props.conversation, id: 'other-chat' },
      draft: '另一会话的正文',
    });
    expect(voice().getAttribute('aria-expanded')).toBe('false');
    expect(f.host.querySelector('.voice-panel')).toBeNull();
    act(() => voice().click());
    const tts = [...f.host.querySelectorAll<HTMLButtonElement>('.voice-panel button')].find(
      (item) => item.textContent?.trim() === 'TTS',
    )!;
    act(() => tts.click());
    expect(f.host.querySelector<HTMLTextAreaElement>('.voice-panel textarea')?.value).toBe(
      '另一会话的正文',
    );
    await f.render();
    expect(voice().getAttribute('aria-expanded')).toBe('false');
  } finally {
    await f.dispose();
  }
});

it.each(['TTS', 'AI 声聊'])('%s 发送成功才清理本次文字，保留随后输入的新文字', async (mode) => {
  const f = await fixture();
  const acknowledgements: Array<() => void> = [];
  const onSend = vi.fn(async (_body, _locals, onAccepted?: () => void) => {
    if (onAccepted) acknowledgements.push(onAccepted);
  });
  try {
    await f.finish();
    await f.render({ onSend });
    const voice = f.host.querySelector<HTMLButtonElement>('button[aria-label="语音"]')!;
    act(() => voice.click());
    const select = [...f.host.querySelectorAll<HTMLButtonElement>('.voice-panel button')].find(
      (item) => item.textContent?.trim() === mode,
    )!;
    act(() => select.click());
    const input = f.host.querySelector<HTMLTextAreaElement>('.voice-panel textarea')!;
    const send = f.host.querySelector<HTMLButtonElement>(
      '.voice-panel button[title="合成并发送"]',
    )!;
    await act(async () => send.click());
    expect(acknowledgements).toHaveLength(1);
    expect(input.value).toBe('原稿');
    act(() => acknowledgements.shift()!());
    expect(input.value).toBe('');
    expect(f.editor().querySelector('img')?.src).toBe('blob:restored');

    const inputText = (text: string) => {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          input,
          text,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    inputText('第二条');
    await act(async () => send.click());
    expect(acknowledgements).toHaveLength(1);
    inputText('下一条草稿');
    act(() => acknowledgements.shift()!());
    expect(input.value).toBe('下一条草稿');
  } finally {
    await f.dispose();
  }
});
