import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  attachmentToElement,
  createAttachment,
} from '../src/renderer/src/im-template/template/composerMedia';
import { composerTextToElements } from '../src/renderer/src/im-template/template/draftElements';

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

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(group = false, draft = '') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn(async (_body: string) => {});
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      h(ChatPane, {
        user: demo.user,
        conversation: demo.conversations.find((row) => row.type === (group ? 'group' : 'direct'))!,
        messages: [],
        draft,
        loading: false,
        onDraftChange: vi.fn(),
        onBack: vi.fn(),
        onSend: send,
        ...{ onSendWindowShake: vi.fn(async () => {}) },
      }),
    ),
  );
  return { host, send };
}

function clickTitle(host: ParentNode, title: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (row) => row.title === title,
  );
  expect(button, title).toBeDefined();
  act(() => button!.click());
}

function choose(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (row) => row.textContent === label,
  );
  expect(button, label).toBeDefined();
  act(() => button!.click());
}

it.each([false, true])('私聊互动表情保留发送，不再提供窗口抖动；展开=%s', async (expanded) => {
  const { host, send } = await mount(false, '未发送的文字');
  if (expanded)
    act(() => host.querySelector<HTMLButtonElement>('.mobile-composer-expand-button')!.click());
  const toolbar = host.querySelector(
    expanded ? '.mobile-composer-expanded-tools' : '.composer-tools',
  )!;
  expect(
    toolbar.querySelector('[title="弹射表情"], [title="互动表情"], [title="窗口抖动"]'),
  ).toBeNull();
  clickTitle(toolbar, '表情');
  expect(document.querySelector('[role="menuitem"]')).toBeNull();
  expect(host.querySelector('[aria-label="表情面板"]')).not.toBeNull();
  clickTitle(host, '弹射表情');
  expect(host.querySelector('[aria-label="弹射表情"]')).not.toBeNull();
  expect(host.querySelector('.emoji-panel .bounce-panel')).not.toBeNull();
  clickTitle(host, '互动表情');
  expect(host.querySelector('[aria-label="互动表情"]')).not.toBeNull();
  expect(host.querySelector('[title="窗口抖动"]')).toBeNull();
  const panel = host.querySelector('[aria-label="互动表情"]')!;
  const submit = [...panel.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes('戳一下'),
  );
  expect(submit).toBeDefined();
  await act(async () => submit!.click());
  expect(send).toHaveBeenCalledOnce();
  expect(host.querySelector('[aria-label="表情面板"]')).toBeNull();
  expect(host.querySelector('.composer-editor')?.textContent).toBe('未发送的文字');
  expect(composerTextToElements(send.mock.calls[0]![0])).toEqual([
    expect.objectContaining({ kind: 'pokeEmoji' }),
  ]);
});

it('群聊语音按钮直接打开录音面板，文字转语音内联并保留 AI 声聊', async () => {
  const { host } = await mount(true);
  clickTitle(host, '表情');
  clickTitle(host, '互动表情');
  expect(host.querySelector('[title="窗口抖动"]')).toBeNull();
  clickTitle(host, '语音');
  expect(document.querySelector('[role="menuitem"]')).toBeNull();
  expect(host.querySelector('.composer > .voice-panel')).not.toBeNull();
  const tts = host.querySelector<HTMLButtonElement>('.voice-panel [role="tab"]:nth-child(2)')!;
  act(() => tts.click());
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
    '文字转语音',
  );
  expect(host.querySelector('.voice-panel .voice-tts')).not.toBeNull();
  expect(host.querySelector('.ai-voice-panel')).toBeNull();
  clickTitle(host, 'AI 声聊');
  expect(host.querySelector('.ai-voice-panel')).not.toBeNull();
});

it('私聊的录音和文字转语音直接共用输入框，不提供群 AI 声聊', async () => {
  const { host } = await mount();
  clickTitle(host, '语音');
  expect(host.querySelector('[aria-label="按住说话"]')).not.toBeNull();
  const tabs = host.querySelectorAll<HTMLButtonElement>('.voice-panel [role="tab"]');
  act(() => tabs[1]!.click());
  expect(host.querySelector('.voice-panel .voice-tts')).not.toBeNull();
  expect(host.querySelector('[title="AI 声聊"]')).toBeNull();
  act(() => tabs[0]!.click());
  expect(host.querySelector('[aria-label="按住说话"]')).not.toBeNull();
});

it('正在请求麦克风时不能切换页签或通过工具栏卸载录音面板', async () => {
  const { host } = await mount();
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  clickTitle(host, '语音');
  await act(async () => {
    host
      .querySelector('[aria-label="按住说话"]')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  });
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLButtonElement>('.voice-panel [role="tab"]')?.disabled).toBe(true);
  clickTitle(host, '表情');
  clickTitle(host, '语音');
  expect(host.querySelector('.voice-panel')).not.toBeNull();
  expect(host.querySelector('.emoji-panel')).toBeNull();
});

it('发送图片或文件提供三个选项，图片选择发送文件后仍生成文件消息', async () => {
  const { host, send } = await mount();
  clickTitle(host, '发送图片或文件');
  expect([...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual(
    ['发送图片', '发送文件', 'QQ闪传'],
  );
  const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
  const picker = vi.spyOn(fileInput, 'click');
  choose('发送文件');
  expect(picker).toHaveBeenCalledOnce();
  const image = new File(['fixture'], 'fixture.png', { type: 'image/png' });
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [image] });
  await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
  expect(host.querySelector('.composer-token-image')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('.composer-send')!.click());
  expect(send).toHaveBeenCalledOnce();
  expect(composerTextToElements(send.mock.calls[0]![0])).toEqual([
    expect.objectContaining({ kind: 'file', fileName: 'fixture.png' }),
  ]);
});

it.each(['image/png', 'video/mp4'])('强制文件发送不读取媒体预览：%s', async (type) => {
  const createUrl = vi.spyOn(URL, 'createObjectURL');
  const file = new File(['fixture'], 'fixture.bin', { type });
  const attachment = await createAttachment(file, 'file');
  expect(attachment.kind).toBe('file');
  expect(attachment.url).toBeNull();
  expect(attachmentToElement(attachment)).toMatchObject({ kind: 'file', fileName: file.name });
  expect(createUrl).not.toHaveBeenCalled();
});
