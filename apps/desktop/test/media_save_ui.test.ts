import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExportSavePolicy } from '@weq/service';
import { MediaSourceSave } from '../src/renderer/src/components/MediaSaveControls';
import { QqFile, QqVoice } from '../src/renderer/src/components/QqMedia';
import { GroupFileDialog } from '../src/renderer/src/components/GroupFileDialog';
import { ImageLightbox, openLightbox } from '../src/renderer/src/components/ImageLightbox';
import { MessageContextMenu } from '../src/renderer/src/im-template/template/messageContextMenu';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { makeSolidPng } from '@weq/protocol';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const state = vi.hoisted(() => ({
  web: false,
  configId: 'source-a',
  model: '',
  prepare: vi.fn(
    async (_intent?: ExportSavePolicy, _output?: unknown): Promise<ExportSavePolicy | null> => ({
      mode: 'before',
      directory: 'selected',
    }),
  ),
  save: vi.fn(async (_input: unknown): Promise<string | null> => 'media-task'),
  receipt: vi.fn(async (_input: unknown) => ({
    status: 'completed' as string,
    error: undefined as string | undefined,
  })),
  download: vi.fn(
    async (_input: unknown): Promise<{ url: string } | null> => ({ url: '/_download/fixture' }),
  ),
  cancel: vi.fn(async (_input: unknown) => true),
  toast: vi.fn(),
  open: vi.fn(),
  transcribe: vi.fn(),
  files: vi.fn(async (_input: unknown) => ({
    targetDirectory: '/',
    folders: [],
    files: [
      {
        fileId: 'file-a',
        fileName: 'report.txt',
        fileSize: 1,
        uploadedTime: 0,
        uploaderName: '',
        busId: 7,
      },
    ],
  })),
}));
vi.mock('../src/renderer/src/components/qq-actions/GroupFileActions', () => ({
  GroupFileActions: () => null,
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return state.web;
  },
  get IS_ELECTRON() {
    return !state.web;
  },
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => {
    const configId = state.configId;
    return {
      binding: { expectedAccountUin: '10001', expectedAccountConfigId: configId },
      settings: { isLoading: false },
      policy: { mode: 'preset', directory: '/saved' },
      prepareSave: state.prepare,
      isCurrent: () => configId === state.configId,
    };
  },
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      listGroupFiles: { query: state.files },
      mediaSave: { save: { mutate: state.save }, cancel: { mutate: state.cancel } },
      getExportOutputReceipt: { query: state.receipt },
      exportTaskDownload: { mutate: state.download },
    },
  },
  trpc: {
    bootstrap: {
      getSettings: { useQuery: () => ({ data: { voiceTranscribe: { modelId: state.model } } }) },
    },
    account: {
      getGroupAlbumAccessState: { useQuery: () => ({ data: undefined }) },
      ocrCacheLookup: { useQuery: () => ({ data: undefined }) },
      ocrChatImage: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      fileResource: { download: { open: { useMutation: () => ({ mutate: state.open }) } } },
      transcribeVoice: { useMutation: () => ({ mutateAsync: state.transcribe, isLoading: false }) },
    },
  },
}));
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.web = false;
  state.configId = 'source-a';
  state.model = '';
  state.prepare.mockReset().mockResolvedValue({ mode: 'before', directory: 'selected' });
  state.save.mockReset().mockResolvedValue('media-task');
  state.receipt.mockReset().mockResolvedValue({ status: 'completed', error: undefined });
  state.download.mockClear();
  state.cancel.mockClear();
  state.toast.mockClear();
  state.open.mockClear();
  state.transcribe.mockClear();
});
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'electron');
});
async function mount(
  element: ReactNode = h(MediaSourceSave, {
    source: { kind: 'url', url: 'weq-media://pic?name=photo.jpg', name: 'photo.jpg' },
    className: 'fixture-save',
    label: '保存图片',
  }),
) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  const close = () => {
    act(() => root.unmount());
    host.remove();
  };
  cleanup.push(close);
  return {
    host,
    close: () => {
      cleanup.splice(cleanup.indexOf(close), 1);
      close();
    },
  };
}
async function click(host: HTMLElement, label: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
}
function capture(node: HTMLElement, name: string) {
  const directory = process.env.WEQ_MEDIA_SAVE_LAYOUT;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const clone = node.cloneNode(true) as HTMLElement;
  for (const image of clone.querySelectorAll<HTMLImageElement>('img')) {
    const url = new URL(image.getAttribute('src') || '/', 'https://synthetic.invalid');
    image.src =
      url.protocol === 'weq-asset:' && url.hostname === 'fileicon'
        ? `/@fs${resolve('../../resources/fileicon', decodeURIComponent(url.pathname.slice(1)))}`
        : `data:image/png;base64,${Buffer.from(makeSolidPng(320, 180, [25, 125, 145])).toString('base64')}`;
  }
  const styles = [
    'styles/index.css',
    'styles/group-media.css',
    'styles/workspace-surfaces.css',
    'styles/page-chrome.css',
    'im-template/styles/emoji.css',
    'styles/lightbox-actions.css',
    'styles/conversation-actions.css',
    'styles/export-save-actions.css',
    'styles/media-save.css',
  ]
    .map((file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src', file)}">`)
    .join('');
  writeFileSync(
    resolve(directory, name),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>html,body{margin:0;height:100%;font-family:system-ui;background:var(--background);color:var(--foreground)}*,*::before,*::after{box-sizing:border-box}.qa-chat{display:grid;gap:24px;padding:16px;max-width:380px}.qa-chat .weq-lightbox-actions{width:max-content}</style><body>${clone.outerHTML}</body></html>`,
  );
}
it('主动作沿用公共偏好，排队只提示受理，不直接写盘或打开浏览器', async () => {
  const view = await mount();
  await click(view.host, '保存图片');
  expect(state.save).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    source: { kind: 'url', url: 'weq-media://pic?name=photo.jpg', name: 'photo.jpg' },
    savePolicy: { mode: 'preset', directory: '/saved' },
  });
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.download).not.toHaveBeenCalled();
  expect(state.toast.mock.calls[0]![0]).toMatchObject({
    tone: 'info',
    title: '媒体保存任务已创建',
  });
});
it('菜单本次另存取消，不修改偏好、不退出控件或清理原资源', async () => {
  const view = await mount();
  state.save.mockResolvedValueOnce(null);
  act(() =>
    view.host.querySelector<HTMLButtonElement>('[aria-label="保存图片的本次保存选项"]')!.click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === '另存到…')!
      .click(),
  );
  expect(state.save.mock.calls[0]![0]).toMatchObject({ savePolicy: { mode: 'before' } });
  expect(view.host.querySelector('[aria-label="保存图片"]')).not.toBeNull();
  expect(state.toast).not.toHaveBeenCalled();
});
it('Web 区分服务器保存和浏览器下载，后者只下载完整任务且不准备服务器位置', async () => {
  state.web = true;
  const view = await mount();
  await click(view.host, '保存图片');
  expect(state.prepare).toHaveBeenCalledWith(undefined, { kind: 'bundle', name: 'photo.jpg' });
  state.prepare.mockClear();
  state.save.mockClear();
  state.toast.mockClear();
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await click(view.host, '保存图片到浏览器');
  await vi.waitFor(() => expect(anchor).toHaveBeenCalledOnce());
  expect(state.save.mock.calls[0]![0]).toMatchObject({ savePolicy: { mode: 'after' } });
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.download).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    taskId: 'media-task',
  });
});
it('浏览器下载等待可停止，不再触发下载链接，已生成结果不删除', async () => {
  state.web = true;
  state.receipt.mockResolvedValueOnce({ status: 'running', error: undefined });
  const view = await mount();
  await click(view.host, '保存图片到浏览器');
  await vi.waitFor(() => expect(state.receipt).toHaveBeenCalledOnce());
  await click(view.host, '停止本次下载');
  expect(state.cancel).toHaveBeenCalledWith({
    expectedAccountUin: '10001',
    expectedAccountConfigId: 'source-a',
    taskId: 'media-task',
  });
  expect(state.download).not.toHaveBeenCalled();
});
it('任务创建期间关闭界面，不让迟到回执触发浏览器下载，也不删除任务结果', async () => {
  state.web = true;
  let release!: (id: string) => void;
  state.save.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const view = await mount();
  await click(view.host, '保存图片到浏览器');
  view.close();
  await act(async () => release('late-task'));
  expect(state.download).not.toHaveBeenCalled();
  expect(state.cancel).not.toHaveBeenCalled();
});
it('同号来源变化后不把旧保存回执反馈给新来源', async () => {
  const view = await mount();
  state.save.mockImplementationOnce(async () => {
    state.configId = 'source-b';
    return 'old-task';
  });
  await click(view.host, '保存图片');
  expect(state.toast).not.toHaveBeenCalled();
  expect(state.download).not.toHaveBeenCalled();
});
it('文件卡片保留本地打开，显式保存仍走公共策略，不把控制按钮嵌进打开按钮', async () => {
  const invoke = vi.fn(async () => ({ success: true }));
  Reflect.defineProperty(window, 'electron', {
    configurable: true,
    value: { ipcRenderer: { invoke } },
  });
  const view = await mount(
    h(QqFile, {
      data: { fileName: 'report.txt', fileToken: 'token' },
      sendTimeMs: 1,
      msgId: '41',
      conv: '123',
    }),
  );
  await act(async () => view.host.querySelector<HTMLButtonElement>('.qq-media-file-open')!.click());
  expect(invoke).toHaveBeenCalledWith('file:reveal', '41');
  expect(state.save).not.toHaveBeenCalled();
  await click(view.host, '保存文件');
  expect(state.save.mock.calls[0]![0]).toMatchObject({
    source: { kind: 'chat-file', msgId: '41', token: 'token', conv: '123', name: 'report.txt' },
  });
  expect(view.host.querySelector('.qq-media-file-open button')).toBeNull();
  expect(view.host.querySelector('.qq-media-file-name')?.getAttribute('title')).toBe('report.txt');
});
it('语音保存复用播放的精确转发定位，不自动播放、转写或调用模型', async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const view = await mount(
    h(QqVoice, {
      data: { fileName: 'voice.amr', fileToken: 'token' },
      sendTimeMs: 1,
      msgId: '42',
      mediaMsgId: '41',
      conv: '123',
      fwd: { fwdMsgId: '42', fwdKind: 'group' },
    }),
  );
  await click(view.host, '保存语音');
  const input = state.save.mock.calls[0]![0] as { source: { url: string; name: string } };
  const url = new URL(input.source.url);
  expect(url.searchParams.get('msgId')).toBe('41');
  expect(url.searchParams.get('fwdMsgId')).toBe('42');
  expect(url.searchParams.get('fwdKind')).toBe('group');
  expect(play).not.toHaveBeenCalled();
  expect(state.transcribe).not.toHaveBeenCalled();
});
it('群文件列表单个保存固定文件身份，不交给未经保存策略的直接链接', async () => {
  const view = await mount(
    h(GroupFileDialog, { groupCode: '123', groupName: '合成群', onClose: vi.fn() }),
  );
  await click(view.host, '保存 report.txt');
  expect(state.save.mock.calls[0]![0]).toMatchObject({
    source: {
      kind: 'group-file',
      groupCode: '123',
      fileId: 'file-a',
      fileName: 'report.txt',
      busId: 7,
    },
    savePolicy: { mode: 'preset', directory: '/saved' },
  });
});
it('独立 Web 窗口的同源绝对媒体地址还原成已有挂载路径', async () => {
  state.web = true;
  const url = new URL('/_media/pic?name=photo.jpg', window.location.href).href;
  const view = await mount(
    h(MediaSourceSave, {
      source: { kind: 'url', url },
      className: 'fixture-save',
      label: '保存图片',
    }),
  );
  await click(view.host, '保存图片');
  expect(state.save.mock.calls[0]![0]).toMatchObject({
    source: { kind: 'url', url: '/_media/pic?name=photo.jpg' },
  });
});
it('图片右键下载菜单分别传递默认、本次另存与稍后保存，不改变消息身份', async () => {
  const message = createTemplateDemoData().messages[0]!,
    download = vi.fn();
  const view = await mount(
    h(MessageContextMenu, {
      state: { message, x: 10, y: 10, downloadUrl: 'weq-media://pic?name=photo.jpg' },
      onCopy: vi.fn(),
      onDownloadImage: download,
    }),
  );
  const action = (name: string) =>
    [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === name,
    )!;
  act(() => action('下载').click());
  act(() => action('另存到…').click());
  act(() => action('先生成，稍后保存').click());
  expect(download.mock.calls).toEqual([
    ['weq-media://pic?name=photo.jpg', message],
    ['weq-media://pic?name=photo.jpg', message, { mode: 'before' }],
    ['weq-media://pic?name=photo.jpg', message, { mode: 'after' }],
  ]);
});
it('图片灯箱选择器取消后仍保留原图和缩放状态，不关闭浏览', async () => {
  state.save.mockResolvedValueOnce(null);
  await mount(h(ImageLightbox));
  act(() => openLightbox('weq-media://pic?name=photo.jpg', 'photo.jpg'));
  try {
    const frame = document.querySelector<HTMLElement>('.weq-lightbox-frame')!;
    act(() =>
      frame.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -120,
          clientX: 10,
          clientY: 10,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const transform = frame.style.transform;
    const button = document.querySelector<HTMLButtonElement>('[aria-label="保存图片"]')!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      button.click();
    });
    expect(document.querySelector('.weq-lightbox-frame')).toBe(frame);
    expect(frame.style.transform).toBe(transform);
    expect(document.querySelector<HTMLImageElement>('.weq-lightbox-image')?.src).toBe(
      'weq-media://pic?name=photo.jpg',
    );
    expect(state.toast).not.toHaveBeenCalled();
  } finally {
    act(() => document.querySelector<HTMLButtonElement>('.weq-lightbox-close')?.click());
  }
});
it.each([false, true])('保存控件合成布局，Web=%s', async (web) => {
  state.web = web;
  state.model = 'synthetic';
  const longName = '这是一份用于检查长文件名不会挤压保存按钮的合成文件.txt';
  const chat = await mount(
    h(
      'section',
      { className: 'qa-chat' },
      h(QqFile, {
        data: { fileName: longName, fileSize: 1024, fileToken: 'token' },
        sendTimeMs: 1,
        msgId: '41',
        conv: '123',
      }),
      h(QqVoice, {
        data: { fileName: 'voice.amr', fileToken: 'token', pttDuration: 6 },
        sendTimeMs: 1,
        msgId: '42',
        conv: '123',
      }),
    ),
  );
  capture(chat.host, web ? 'media-chat-web.html' : 'media-chat-desktop.html');
  expect(chat.host.querySelectorAll('.weq-media-save-controls')).toHaveLength(2);
  state.files.mockResolvedValueOnce({
    targetDirectory: '/',
    folders: [],
    files: [
      {
        fileId: 'file-a',
        fileName: longName,
        fileSize: 1024,
        uploadedTime: 0,
        uploaderName: '',
        busId: 7,
      },
    ],
  });
  const group = await mount(
    h(GroupFileDialog, { groupCode: '123', groupName: '合成群', onClose: vi.fn() }),
  );
  capture(group.host, web ? 'media-group-web.html' : 'media-group-desktop.html');
  expect(group.host.querySelector('.weq-media-save-controls')).not.toBeNull();
  await mount(h(ImageLightbox));
  act(() => openLightbox('weq-media://pic?name=photo.png', '合成图片.png'));
  try {
    capture(
      document.querySelector<HTMLElement>('.weq-lightbox-layer')!,
      web ? 'media-lightbox-web.html' : 'media-lightbox-desktop.html',
    );
  } finally {
    act(() => document.querySelector<HTMLButtonElement>('.weq-lightbox-close')?.click());
  }
});
