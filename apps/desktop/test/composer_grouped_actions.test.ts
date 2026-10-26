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

async function mount(group = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn(async (_body: string) => {});
  const shake = vi.fn(async () => {});
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
        draft: '',
        loading: false,
        onDraftChange: vi.fn(),
        onBack: vi.fn(),
        onSend: send,
        onSendWindowShake: shake,
      }),
    ),
  );
  return { host, send, shake };
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

it.each([false, true])('表情入口合并，互动表情内提供私聊窗口抖动；展开=%s', async (expanded) => {
  const { host, shake } = await mount();
  if (expanded)
    act(() => host.querySelector<HTMLButtonElement>('.mobile-composer-expand-button')!.click());
  const toolbar = host.querySelector(
    expanded ? '.mobile-composer-expanded-tools' : '.composer-tools',
  )!;
  expect(
    toolbar.querySelector('[title="弹射表情"], [title="互动表情"], [title="窗口抖动"]'),
  ).toBeNull();
  clickTitle(toolbar, '表情');
  expect([...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual(
    ['表情', '弹射表情', '互动表情'],
  );
  choose('弹射表情');
  expect(host.querySelector('[aria-label="弹射表情"]')).not.toBeNull();
  clickTitle(toolbar, '表情');
  choose('互动表情');
  expect(host.querySelector('[aria-label="互动表情"]')).not.toBeNull();
  clickTitle(host, '窗口抖动');
  await act(async () => {});
  expect(shake).toHaveBeenCalledOnce();
});

it('群聊互动表情不提供窗口抖动，语音菜单保留 AI 声聊', async () => {
  const { host } = await mount(true);
  clickTitle(host, '表情');
  choose('互动表情');
  expect(host.querySelector('[title="窗口抖动"]')).toBeNull();
  clickTitle(host, '语音');
  expect([...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual(
    ['录音', '文字转语音', 'AI 声聊'],
  );
  choose('文字转语音');
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
    '文字转语音',
  );
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
