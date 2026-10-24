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
    },
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
    expect(open).toHaveBeenCalledWith('about:blank', 'weq-call', 'popup,width=400,height=600');
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
