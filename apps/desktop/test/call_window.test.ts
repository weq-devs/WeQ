import { act, createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { applicationToolPopupOptions } from '../src/main/tool_window';
import { CallWindow } from '../src/renderer/src/components/CallWindow';
import { useAppLock } from '../src/renderer/src/state/lock';

type CallInfo = Parameters<typeof CallWindow>[0]['initial'];
const mocks = vi.hoisted(() => ({
  hangup: vi.fn(),
  hangupError: null as null | (() => void),
  state: null as null | { onData: (call: CallInfo) => void },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    call: {
      hangup: {
        useMutation: (options: { onError: () => void }) => {
          mocks.hangupError = options.onError;
          return { mutate: mocks.hangup, isPending: false };
        },
      },
      pushAudio: { useMutation: () => ({ mutate: vi.fn() }) },
      onCallState: {
        useSubscription: (_input: unknown, options: typeof mocks.state) => {
          mocks.state = options;
        },
      },
      onCallAudio: { useSubscription: () => {} },
      onCallVideo: { useSubscription: () => {} },
      onCallRecording: { useSubscription: () => {} },
      onCallError: { useSubscription: () => {} },
      setCamera: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      pushVideoFrame: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      // 录音相关的 RPC：这个测试只关心窗口生命周期与通话控件，录音一律给空。
      startRecording: { useMutation: () => ({ mutateAsync: vi.fn(), isLoading: false }) },
      stopRecording: { useMutation: () => ({ mutateAsync: vi.fn(), isLoading: false }) },
      pushSystemAudio: { useMutation: () => ({ mutate: vi.fn() }) },
      recordingCapabilities: {
        useQuery: () => ({ data: { systemAudio: 'unsupported', dir: null }, refetch: vi.fn() }),
      },
      recordingForMessage: { useQuery: () => ({ data: null }) },
    },
    bootstrap: {
      getSettings: { useQuery: () => ({ data: undefined, refetch: vi.fn() }) },
      setCallRecording: { useMutation: () => ({ mutate: vi.fn(), isLoading: false }) },
      pickCallRecordingDir: { useMutation: () => ({ mutate: vi.fn(), isLoading: false }) },
    },
    help: { openFolder: { useMutation: () => ({ mutate: vi.fn() }) } },
  },
}));
vi.mock('../src/renderer/src/components/HoverTooltip', () => ({ HoverTooltip: () => null }));

const initial: CallInfo = {
  state: 'connecting',
  roomId: 'fixture-room',
  peerUin: '10001',
  peerUid: 'u_fixture',
  peerName: '合成好友',
  peerAvatar: '',
  backgroundUrl: '',
  backgroundVideoUrl: '',
  startedAt: null,
  connectedAt: null,
  endReason: null,
  lastError: null,
  sentFrames: 0,
  receivedFrames: 0,
  durationSec: 0,
  videoSending: false,
  videoReceiving: false,
  receivedVideoFrames: 0,
  videoInfo: null,
};

afterEach(() => {
  useAppLock.getState().unlock();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mocks.hangup.mockClear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
});

function mount(strict = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  act(() =>
    root.render(
      strict
        ? h(StrictMode, null, h(CallWindow, { initial, onClose }))
        : h(CallWindow, { initial, onClose }),
    ),
  );
  return {
    host,
    onClose,
    async dispose() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

it('仅为登记的空白通话窗口提供系统边框，不向子窗暴露特权', () => {
  expect(applicationToolPopupOptions('https://example.invalid', 'weq-call')).toBeNull();
  expect(applicationToolPopupOptions('about:blank', 'weq-call')).toMatchObject({
    title: 'WeQ · 语音通话',
    frame: true,
    minWidth: 340,
    minHeight: 540,
    webPreferences: {
      preload: undefined,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
});

it('界面仅挂在子窗口，主题同步，通话控件可用，结束后自动关窗且不重复挂断', async () => {
  vi.useFakeTimers();
  const popup = new HappyWindow();
  const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const close = vi.spyOn(popup, 'close');
  const app = mount();
  try {
    expect(open).toHaveBeenCalledWith('about:blank', 'weq-call', 'popup,width=400,height=620');
    expect(app.host.querySelector('[aria-label="语音通话"]')).toBeNull();
    expect(popup.document.querySelector('[aria-label="语音通话"]')).not.toBeNull();
    expect(popup.document.title).toBe('WeQ · 语音通话');
    act(() => useAppLock.getState().lock());
    expect(popup.document.querySelector('[aria-label="语音通话"]')?.hasAttribute('hidden')).toBe(
      true,
    );
    expect(popup.document.body.textContent).toContain('应用已锁定');
    act(() => useAppLock.getState().unlock());
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.documentElement.style.setProperty('--weq-accent-effective', '#e5484d');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(popup.document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(popup.document.documentElement.style.getPropertyValue('--weq-accent-effective')).toBe(
      '#e5484d',
    );
    act(() => popup.document.querySelector<HTMLButtonElement>('[title="静音"]')!.click());
    expect(popup.document.querySelector('[title="取消静音"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    act(() => {
      popup.document.querySelector<HTMLButtonElement>('[title="挂断"]')!.click();
      popup.document.querySelector<HTMLButtonElement>('[title="挂断"]')!.click();
    });
    expect(mocks.hangup).toHaveBeenCalledOnce();
    act(() => mocks.state!.onData({ ...initial, state: 'ended', endReason: 'hangup' }));
    expect(popup.document.body.textContent).toContain('已挂断');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(close).toHaveBeenCalledOnce();
    expect(app.onClose).toHaveBeenCalledOnce();
  } finally {
    await app.dispose();
    popup.close();
  }
  expect(mocks.hangup).toHaveBeenCalledOnce();
});

it('手动关闭系统窗口会挂断并清理主界面的通话状态', async () => {
  vi.useFakeTimers();
  const popup = new HappyWindow();
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const app = mount();
  try {
    Object.defineProperty(popup, 'closed', { value: true, configurable: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mocks.hangup).toHaveBeenCalledOnce();
    expect(app.onClose).toHaveBeenCalledOnce();
  } finally {
    await app.dispose();
    popup.close();
  }
  expect(mocks.hangup).toHaveBeenCalledOnce();
});

it('挂断请求失败后允许重试', async () => {
  const popup = new HappyWindow();
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const app = mount();
  try {
    const button = popup.document.querySelector<HTMLButtonElement>('[title="挂断"]')!;
    act(() => button.click());
    expect(mocks.hangup).toHaveBeenCalledOnce();
    act(() => mocks.hangupError!());
    act(() => button.click());
    expect(mocks.hangup).toHaveBeenCalledTimes(2);
  } finally {
    await app.dispose();
    popup.close();
  }
});

it('窗口被阻止时挂断，不退回遮挡聊天的浮层', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  const app = mount();
  try {
    expect(mocks.hangup).toHaveBeenCalledOnce();
    expect(app.onClose).toHaveBeenCalledOnce();
    expect(app.host.textContent).toBe('');
  } finally {
    await app.dispose();
  }
});

it('StrictMode 重挂载不会误挂断，真正卸载才挂断并关闭窗口', async () => {
  const popups: HappyWindow[] = [];
  vi.spyOn(window, 'open').mockImplementation(() => {
    const popup = new HappyWindow();
    popups.push(popup);
    return popup as unknown as Window;
  });
  const app = mount(true);
  await act(async () => {});
  expect(mocks.hangup).not.toHaveBeenCalled();
  const close = vi.spyOn(popups.at(-1)!, 'close');
  await app.dispose();
  expect(mocks.hangup).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalled();
  for (const popup of popups) popup.close();
});

it('StrictMode 模拟卸载不会关掉刚打开的通话窗口', async () => {
  // Chromium 里 `window.close()` 之后 `closed` 不是同步置位的：紧接着的同名
  // `window.open` 会拿回那个正在销毁的窗口。模拟卸载若真去关窗，重挂载就会
  // 复用这个将死的窗口，200ms 后轮询到「已关闭」→ 自己把通话挂断。
  vi.useFakeTimers();
  const popups: Array<{ win: HappyWindow; closeCalls: number }> = [];
  vi.spyOn(window, 'open').mockImplementation(() => {
    const win = new HappyWindow();
    const record = { win, closeCalls: 0 };
    popups.push(record);
    (win as unknown as { close: () => void }).close = () => {
      record.closeCalls += 1;
      setTimeout(() => {
        Object.defineProperty(win, 'closed', { value: true, configurable: true });
      }, 0);
    };
    return win as unknown as Window;
  });

  const app = mount(true);
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(popups).toHaveLength(1);
    expect(popups[0]!.closeCalls).toBe(0);
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(app.onClose).not.toHaveBeenCalled();
  } finally {
    await app.dispose();
    for (const { win } of popups) win.close();
  }
});

/**
 * 三种通话布局。
 *
 * 布局由 `CallStage` 上的 `data-layout` 决定，CSS 再据此分流：
 *   audio —— 双方语音（背景 / 大头像 / 波形）
 *   peer  —— 只有对端开视频（画面铺满 + 角落头像）
 *   self  —— 双方都有视频（对端铺满 + 本端画中画）
 */
async function mountWithState(overrides: Partial<CallInfo>) {
  const popups: HappyWindow[] = [];
  vi.spyOn(window, 'open').mockImplementation(() => {
    const popup = new HappyWindow();
    popups.push(popup);
    return popup as unknown as Window;
  });
  const app = mount();
  await act(async () => {});
  // 状态是从订阅推过来的，模拟一次服务端推送。
  await act(async () => {
    mocks.state?.onData({ ...initial, state: 'connected', ...overrides });
  });
  const stage = () => popups.at(-1)?.document.querySelector('.weq-call-stage');
  return { app, popups, stage };
}

it('双方语音时是 audio 布局，不挂载视频画布', async () => {
  const { app, popups, stage } = await mountWithState({});
  try {
    expect(stage()?.getAttribute('data-layout')).toBe('audio');
    expect(popups.at(-1)?.document.querySelector('.weq-call-peer-video')).toBeNull();
    expect(popups.at(-1)?.document.querySelector('.weq-call-self-video')).toBeNull();
  } finally {
    await app.dispose();
    for (const popup of popups) popup.close();
  }
});

it('只有对端开视频时是 peer 布局，有画布但没有画中画', async () => {
  const { app, popups, stage } = await mountWithState({ videoReceiving: true });
  try {
    expect(stage()?.getAttribute('data-layout')).toBe('peer');
    expect(popups.at(-1)?.document.querySelector('.weq-call-peer-video canvas')).not.toBeNull();
    expect(popups.at(-1)?.document.querySelector('.weq-call-self-video')).toBeNull();
  } finally {
    await app.dispose();
    for (const popup of popups) popup.close();
  }
});

it('双方都开视频时是 self 布局，本端有画中画', async () => {
  const { app, popups, stage } = await mountWithState({
    videoReceiving: true,
    videoSending: true,
  });
  try {
    expect(stage()?.getAttribute('data-layout')).toBe('self');
    expect(popups.at(-1)?.document.querySelector('.weq-call-peer-video canvas')).not.toBeNull();
    expect(popups.at(-1)?.document.querySelector('.weq-call-self-video canvas')).not.toBeNull();
  } finally {
    await app.dispose();
    for (const popup of popups) popup.close();
  }
});

it('只有本端开摄像头时是 self-only 布局，本端画面铺满主区域', async () => {
  const { app, popups, stage } = await mountWithState({ videoSending: true });
  try {
    expect(stage()?.getAttribute('data-layout')).toBe('self-only');
    // 对端没开视频，不该出现「等待对方画面」。
    expect(popups.at(-1)?.document.querySelector('.weq-call-peer-video')).toBeNull();
    // 本端画面铺满，不是小窗。
    const self = popups.at(-1)?.document.querySelector('.weq-call-self-video');
    expect(self).not.toBeNull();
    expect(self!.classList.contains('is-full')).toBe(true);
  } finally {
    await app.dispose();
    for (const popup of popups) popup.close();
  }
});

it('未接通时摄像头按钮不可点', async () => {
  const popups: HappyWindow[] = [];
  vi.spyOn(window, 'open').mockImplementation(() => {
    const popup = new HappyWindow();
    popups.push(popup);
    return popup as unknown as Window;
  });
  const app = mount();
  await act(async () => {});
  try {
    const buttons = [
      ...(popups.at(-1)?.document.querySelectorAll<HTMLButtonElement>('.weq-call-actions button') ??
        []),
    ];
    const camera = buttons.find((button) => button.title.includes('摄像头'));
    expect(camera).toBeDefined();
    expect(camera!.disabled).toBe(true);
  } finally {
    await app.dispose();
    for (const popup of popups) popup.close();
  }
});
