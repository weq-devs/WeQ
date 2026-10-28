import { act, createElement as h, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QqVoice } from '../src/renderer/src/components/QqMedia';
import { MessageContextMenu } from '../src/renderer/src/im-template/template/messageContextMenu';
import type { Message } from '../src/renderer/src/im-template/template/types';
import { useViewState } from '../src/renderer/src/state/view';
import { queueVoiceTranscription } from '../src/renderer/src/hooks/useVoiceTranscription';
import { VoiceAutoTranscribeSetting } from '../src/renderer/src/components/settings/VoiceAutoTranscribeSetting';
import {
  resolveSettingsTarget,
  settingsGroupFor,
} from '../src/renderer/src/components/settings/navigation';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const state = vi.hoisted(() => ({
  automatic: false,
  model: 'synthetic-model',
  transcribe: vi.fn(
    async (_input: unknown): Promise<{ success: boolean; text?: string; error?: string }> => ({
      success: true,
      text: '合成语音文字',
    }),
  ),
  intersection: null as null | ((entries: { isIntersecting: boolean }[]) => void),
  setAutomatic: vi.fn(async (_input: { enabled: boolean }) => true),
  invalidate: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: { transcribeVoice: { mutate: state.transcribe } },
  },
  trpc: {
    useUtils: () => ({ bootstrap: { getSettings: { invalidate: state.invalidate } } }),
    bootstrap: {
      getSettings: {
        useQuery: () => ({
          data: { voiceTranscribe: { modelId: state.model, autoTranscribe: state.automatic } },
        }),
      },
      setAutoTranscribeVoice: { useMutation: () => ({ mutateAsync: state.setAutomatic }) },
    },
    account: {
      _def: () => ({ path: ['account'] }),
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'fixture' } }) },
    },
  },
}));
vi.mock('../src/renderer/src/components/MediaSaveControls', () => ({
  MediaSourceSave: () => null,
  MediaSaveControls: () => null,
  useMediaSave: () => ({}),
}));

const message: Message = {
  id: 'voice',
  msgId: '42',
  conversationId: 'test',
  senderId: 'sender',
  body: '[语音]',
  createdAt: '2026-10-28T10:00:00+08:00',
  qqElements: [{ type: 'ptt', data: { fileName: 'fixture.silk', pttDuration: 5 } }],
};
function Chat({ stored = '', identity = 'fixture.silk' }: { stored?: string; identity?: string }) {
  const [menu, setMenu] = useState(false);
  const data = { ...message.qqElements![0]!.data, fileName: identity, pttTranscript: stored };
  return h(
    'div',
    {
      onContextMenu: (event) => {
        event.preventDefault();
        setMenu(true);
      },
    },
    h(QqVoice, { data, sendTimeMs: Date.parse(message.createdAt), msgId: message.msgId }),
    menu
      ? h(MessageContextMenu, {
          state: { x: 10, y: 10, message: { ...message, qqElements: [{ type: 'ptt', data }] } },
          onCopy: () => {},
          onClose: () => setMenu(false),
        })
      : null,
  );
}
let root: Root;
let host: HTMLDivElement;
let cache: QueryClient;
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
function render(props: { stored?: string; identity?: string } = {}) {
  act(() => root.render(h(QueryClientProvider, { client: cache }, h(Chat, props))));
}
function rightClick() {
  act(() =>
    host
      .querySelector('.qq-media-voice')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
}
function click(title: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
  expect(button).not.toBeNull();
  act(() => button.click());
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  state.automatic = false;
  state.model = 'synthetic-model';
  state.setAutomatic.mockClear();
  state.invalidate.mockClear();
  state.transcribe.mockReset().mockResolvedValue({ success: true, text: '合成语音文字' });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof state.intersection) {
        state.intersection = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  useViewState.setState({ openedUin: '10001' });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  cache.clear();
  host.remove();
  vi.unstubAllGlobals();
});

describe('语音消息转换入口', () => {
  it('设置页使用独立自动开关保存偏好，并沿用设置和菜单样式', async () => {
    expect(
      resolveSettingsTarget({ section: 'chat-messages', settingId: 'auto-transcribe-voice' }),
    ).toMatchObject({ section: 'chat-messages', item: '语音消息自动转文字' });
    expect(settingsGroupFor('chat-messages').label).toBe('基础功能');
    act(() =>
      root.render(
        h(
          QueryClientProvider,
          { client: cache },
          h('main', null, h('h2', null, '聊天消息'), h(VoiceAutoTranscribeSetting), h(Chat)),
        ),
      ),
    );
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle.click());
    expect(state.setAutomatic).toHaveBeenCalledWith({ enabled: true });
    expect(state.invalidate).toHaveBeenCalledOnce();
    rightClick();
    const output = process.env.WEQ_VOICE_UI_ARTIFACTS;
    if (output) {
      mkdirSync(output, { recursive: true });
      const styles = [
        'styles/index.css',
        'styles/settings-resources.css',
        'styles/settings-controls.css',
        'styles/workspace-surfaces.css',
        'im-template/styles/emoji.css',
        'im-template/styles/chat.css',
      ]
        .map((file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src', file)}">`)
        .join('');
      writeFileSync(
        resolve(output, 'voice-settings.html'),
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>body{margin:0;padding:16px;background:var(--weq-chat-bg);color:var(--foreground)}main{max-width:620px}.message-context-menu{left:32px!important;top:380px!important}.qq-voice-wrap{margin-top:24px}</style><body>${host.innerHTML}</body></html>`,
      );
    }
  });
  it('右键转换后原气泡显示结果，手动入口共用正在处理的状态', async () => {
    let finish!: (value: { success: boolean; text: string }) => void;
    state.transcribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render();
    rightClick();
    click('转换为文字');
    await settle();
    expect(state.transcribe).toHaveBeenCalledOnce();
    expect(host.querySelector<HTMLButtonElement>('button[title="转文字"]')!.disabled).toBe(true);
    rightClick();
    expect(host.querySelector<HTMLButtonElement>('.message-context-menu button')!.disabled).toBe(
      true,
    );
    await act(async () => finish({ success: true, text: '识别完成' }));
    await settle();
    expect(host.querySelector('.qq-voice-transcript')?.textContent).toBe('识别完成');
    expect(host.querySelector('button[title="转换为文字"]')).toBeNull();
    expect(state.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        msgId: '42',
        expectedAccountUin: '10001',
        expectedAccountConfigId: 'fixture',
      }),
    );
  });

  it('默认不自动转换，开启后只转换进入视野且没有文字的语音', async () => {
    render();
    act(() => state.intersection?.([{ isIntersecting: true }]));
    await settle();
    expect(state.transcribe).not.toHaveBeenCalled();
    state.automatic = true;
    render();
    await settle();
    expect(state.transcribe).toHaveBeenCalledOnce();
    render({ identity: 'another.silk', stored: '已有文字' });
    await settle();
    expect(host.querySelector('.qq-voice-transcript')?.textContent).toBe('已有文字');
    expect(state.transcribe).toHaveBeenCalledOnce();
  });

  it('视野外不自动转换，没有模型的右键入口明确禁用', async () => {
    state.automatic = true;
    render();
    await settle();
    expect(state.transcribe).not.toHaveBeenCalled();
    state.model = '';
    render();
    rightClick();
    expect(
      host.querySelector<HTMLButtonElement>('button[title="请先在设置中选择本地语音模型"]')!
        .disabled,
    ).toBe(true);
  });

  it.each(['response', 'exception'])(
    '%s 失败不自动循环重试，气泡允许手动重试，空成功结果也不重复转换',
    async (failure) => {
      state.automatic = true;
      if (failure === 'exception') state.transcribe.mockRejectedValueOnce(new Error('合成失败'));
      else state.transcribe.mockResolvedValueOnce({ success: false, error: '合成失败' });
      state.transcribe.mockResolvedValue({ success: true, text: '' });
      render();
      act(() => state.intersection?.([{ isIntersecting: true }]));
      await settle();
      expect(host.querySelector('.qq-voice-transcript')?.textContent).toBe('合成失败');
      act(() => state.intersection?.([{ isIntersecting: false }]));
      act(() => state.intersection?.([{ isIntersecting: true }]));
      await settle();
      expect(state.transcribe).toHaveBeenCalledOnce();
      click('转文字');
      await settle();
      expect(state.transcribe).toHaveBeenCalledTimes(2);
      expect(host.querySelector('.qq-voice-transcript')?.textContent).toBe('（未识别到内容）');
      render();
      await settle();
      expect(state.transcribe).toHaveBeenCalledTimes(2);
    },
  );

  it('识别队列串行执行，取消排队项目不妨碍后续转换', async () => {
    const signal = new AbortController();
    let finish!: () => void;
    const first = queueVoiceTranscription(
      signal.signal,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const cancelled = new AbortController();
    const run = vi.fn(async () => 'second');
    const second = queueVoiceTranscription(cancelled.signal, run);
    const rejected = expect(second).rejects.toThrow();
    cancelled.abort();
    expect(run).not.toHaveBeenCalled();
    finish();
    await first;
    await rejected;
    expect(run).not.toHaveBeenCalled();
    await expect(queueVoiceTranscription(signal.signal, run)).resolves.toBe('second');
  });
});
