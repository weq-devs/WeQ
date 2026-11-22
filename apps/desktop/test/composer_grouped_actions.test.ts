import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { ConversationActionsMenu } from '../src/renderer/src/components/ConversationActionsMenu';
import { createTemplateDemoData } from './support/templateDemoData';
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
            : key === 'catalog'
              ? {
                  useQuery: () => ({
                    data: {
                      faces: [
                        {
                          key: 'synthetic',
                          label: '合成表情',
                          unicode: false,
                          items: [{ id: '14', desc: '合成微笑', unicode: false, glyph: '' }],
                        },
                      ],
                    },
                  }),
                }
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
  const sendFlashPhoto = vi.fn(async () => {});
  const sendBubbleVideo = vi.fn(async () => {});
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
        onDraftClear: vi.fn(),
        onBack: vi.fn(),
        onSend: send,
        onSendFlashPhoto: sendFlashPhoto,
        onSendBubbleVideo: sendBubbleVideo,
        onStartCall: vi.fn(),
        ...{ onSendWindowShake: vi.fn(async () => {}) },
      }),
    ),
  );
  return { host, send, sendFlashPhoto, sendBubbleVideo };
}

function clickTitle(host: ParentNode, title: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (row) => row.title === title,
  );
  expect(button, title).toBeDefined();
  act(() => button!.click());
}

function voiceModes(host: ParentNode) {
  return [...host.querySelectorAll<HTMLButtonElement>('[aria-label="语音方式"] button')];
}

function choose(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (row) => row.textContent === label,
  );
  expect(button, label).toBeDefined();
  act(() => button!.click());
}

it('输入框工具栏共用桌面端按钮列表，位置只保留一个入口且可再次点击收起', async () => {
  const { host } = await mount();
  const toolbar = host.querySelector('.composer-tools')!;
  expect([...toolbar.querySelectorAll('button')].map((button) => button.title)).toEqual([
    '表情',
    '红包 / 礼物',
    '通话',
    '语音',
    '发送图片或文件',
    '发送 Ark 卡片',
    '位置',
  ]);
  expect(toolbar.querySelector('.composer-mobile-tool')).toBeNull();
  clickTitle(toolbar, '位置');
  expect(document.querySelector('[role="menu"][aria-label="位置"]')).not.toBeNull();
  clickTitle(toolbar, '位置');
  expect(document.querySelector('[role="menu"][aria-label="位置"]')).toBeNull();
});

it('表情选择器上方的右键菜单点击及 Escape 不会穿透关闭选择器', async () => {
  const { host } = await mount();
  clickTitle(host, '表情');
  const menuHost = document.createElement('div');
  document.body.append(menuHost);
  const menuRoot = createRoot(menuHost);
  cleanups.push(() => {
    act(() => menuRoot.unmount());
    menuHost.remove();
  });
  const action = vi.fn();
  const open = () =>
    act(() =>
      menuRoot.render(
        h(ConversationActionsMenu, {
          x: 20,
          y: 20,
          label: '收藏表情操作',
          onClose: () => menuRoot.render(null),
          actions: [{ label: '保存', icon: h('span'), action }],
        }),
      ),
    );
  open();
  const button = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  act(() => {
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    button.click();
  });
  expect(action).toHaveBeenCalledOnce();
  expect(host.querySelector('[aria-label="表情面板"]')).not.toBeNull();
  open();
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    ),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(host.querySelector('[aria-label="表情面板"]')).not.toBeNull();
});

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
  clickTitle(host.querySelector('[aria-label="表情面板"]')!, '表情');
  act(() =>
    host
      .querySelector('button[title="合成微笑"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
  expect(host.querySelector('.emoji-panel [aria-label="弹射表情"]')).not.toBeNull();
  expect(send).not.toHaveBeenCalled();
  clickTitle(host, '互动表情');
  expect(host.querySelector('[aria-label="互动表情"]')).not.toBeNull();
  expect(host.querySelector('[title="窗口抖动"]')).toBeNull();
  const panel = host.querySelector('[aria-label="互动表情"]')!;
  const submit = panel.querySelector<HTMLButtonElement>('button[title="发送戳一戳"]')!;
  expect(submit.disabled).toBe(false);
  await act(async () => submit.click());
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
  const [record, tts, ai] = voiceModes(host);
  expect(record?.getAttribute('aria-pressed')).toBe('true');
  act(() => tts.click());
  expect(tts.getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('.voice-panel [aria-label="合成文字"]')).not.toBeNull();
  expect(host.querySelector('.ai-voice-controls')).toBeNull();
  act(() => ai.click());
  expect(ai.getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('.ai-voice-controls')).not.toBeNull();
});

it('私聊的录音和文字转语音直接共用输入框，不提供群 AI 声聊', async () => {
  const { host } = await mount();
  clickTitle(host, '语音');
  expect(host.querySelector('[aria-label="点击录音"]')).not.toBeNull();
  const modes = voiceModes(host);
  expect(modes.map((button) => button.textContent?.trim())).toEqual(['录音', 'TTS']);
  act(() => modes[1]!.click());
  expect(host.querySelector('.voice-panel [aria-label="合成文字"]')).not.toBeNull();
  act(() => modes[0]!.click());
  expect(host.querySelector('[aria-label="点击录音"]')).not.toBeNull();
});

it('请求麦克风时锁定语音方式，收起再打开仍保留同一次录音请求', async () => {
  const { host } = await mount();
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  clickTitle(host, '语音');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="点击录音"]')!.click());
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(voiceModes(host).map((button) => button.disabled)).toEqual([true, true]);
  clickTitle(host, '语音');
  expect(host.querySelector('.voice-panel')).toBeNull();
  clickTitle(host, '语音');
  expect(host.querySelector('.voice-panel [aria-label="结束录音"]')).not.toBeNull();
  expect(getUserMedia).toHaveBeenCalledOnce();
});

it('发送图片或文件提供五个选项，图片选择发送文件后仍生成文件消息', async () => {
  const { host, send } = await mount();
  clickTitle(host, '发送图片或文件');
  expect([...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual(
    ['发送图片', '发送文件', '闪照', '泡泡消息', 'QQ闪传'],
  );
  const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
  const picker = vi.spyOn(fileInput, 'click');
  choose('发送文件');
  expect(picker).toHaveBeenCalledOnce();
  const image = new File(['fixture'], 'fixture.png', { type: 'image/png' });
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [image] });
  await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
  expect(host.querySelector('.composer-token-image')).toBeNull();
  await sendWithEnter(host);
  expect(send).toHaveBeenCalledOnce();
  expect(composerTextToElements(send.mock.calls[0]![0])).toEqual([
    expect.objectContaining({ kind: 'file', fileName: 'fixture.png' }),
  ]);
});

async function sendWithEnter(host: HTMLElement) {
  await act(async () => new Promise(requestAnimationFrame));
  const editor = host.querySelector('[aria-label="消息"]')!;
  expect(document.activeElement).toBe(editor);
  await act(async () => {
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

it.each([
  ['闪照', 'image/png', 'fixture.png', 'sendFlashPhoto'],
  ['泡泡消息', 'video/mp4', 'fixture.mp4', 'sendBubbleVideo'],
] as const)('选择%s后按回车才发送，保留文字草稿', async (label, type, name, callback) => {
  const chat = await mount(false, '保留草稿');
  const { host, send } = chat;
  const picker = vi.spyOn(HTMLInputElement.prototype, 'click');
  clickTitle(host, '发送图片或文件');
  choose(label);
  const input = picker.mock.contexts[0] as HTMLInputElement;
  const file = new File(['fixture'], name, { type });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(host.querySelector('[aria-label="待发送附件 1 项"]')?.textContent).toContain(label);
  expect(chat[callback]).not.toHaveBeenCalled();
  await sendWithEnter(host);
  expect(chat[callback]).toHaveBeenCalledWith(expect.anything(), { file, name });
  expect(send).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="消息"]')?.textContent).toBe('保留草稿');
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
