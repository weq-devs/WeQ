// @vitest-environment node
/**
 * 屏幕共享放行 handler：**谁能共享、拒绝时的行为**。
 *
 * ## 钉住的真机 bug（2026-10-28）
 *
 * 第一版按 `request.frame?.name === 'weq-call'` 判断调用方。实测
 * **`frame.name` 是空串** —— 它取的是 `<iframe>` 的 name，不是 `window.open`
 * 传的窗口名。于是每次共享都走 deny 分支，`callback(null)`，而 Chromium 把这种
 * 拒绝报成：
 *
 * ```
 * AbortError: Invalid capture constraints
 * ```
 *
 * 这个错误名极具误导性：它跟分辨率 / 帧率约束毫无关系，实际是主进程拒绝了请求。
 * 当时差点去改渲染层的约束（加了 `max`、试了 `exact`），全都没用。
 *
 * 现在改成按 `webContents` 身份判断：**主窗口拒绝，其余窗口放行**。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  frame: null as null | { name: string },
  owner: null as null | { id: number },
  sources: [] as Array<{ id: string; name: string }>,
  handler: null as null | ((request: unknown, callback: (s: unknown) => void) => Promise<void>),
}));

vi.mock('electron', () => ({
  desktopCapturer: {
    getSources: vi.fn(async () => mocks.sources),
  },
  session: { defaultSession: {} },
  webContents: {
    fromFrame: () => mocks.owner,
  },
}));

vi.mock('@weq/service', () => ({
  getLogger: () => ({
    child: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  }),
}));

import {
  displayMediaMainWebContentsId,
  installCallDisplayMediaHandler,
  setDisplayMediaMainWebContents,
} from '../src/main/call_display_media';

/** 装一个假的 session，把 handler 抓出来直接调用。 */
function captureHandler() {
  const target = {
    setDisplayMediaRequestHandler: (
      handler: (request: unknown, callback: (s: unknown) => void) => Promise<void>,
    ) => {
      mocks.handler = handler;
    },
  };
  installCallDisplayMediaHandler(target as never);
  return mocks.handler!;
}

/** 跑一次请求，返回 callback 收到的值。 */
async function request(options: { video?: boolean; audio?: boolean } = {}): Promise<unknown> {
  const handler = mocks.handler!;
  let received: unknown = 'NOT_CALLED';
  await handler(
    {
      frame: mocks.frame,
      videoRequested: options.video ?? true,
      audioRequested: options.audio ?? false,
      securityOrigin: 'file://',
      userGesture: true,
    },
    (streams) => {
      received = streams;
    },
  );
  return received;
}

beforeEach(() => {
  mocks.frame = { name: '' };
  mocks.owner = { id: 42 };
  mocks.sources = [{ id: 'screen:1:0', name: '整个屏幕' }];
  setDisplayMediaMainWebContents(null);
  captureHandler();
});

describe('屏幕共享放行', () => {
  it('工具窗请求放行，交出 screen 源', async () => {
    const streams = await request();
    expect(streams).toMatchObject({ video: { id: 'screen:1:0' } });
  });

  it('frame 为空（请求方已销毁）时拒绝', async () => {
    mocks.frame = null;
    expect(await request()).toBeNull();
  });

  it('请求来自主窗口时拒绝', async () => {
    setDisplayMediaMainWebContents(42);
    expect(displayMediaMainWebContentsId()).toBe(42);
    // owner.id === 主窗口 id
    expect(await request()).toBeNull();
  });

  it('主窗口之外的窗口放行（窗口改名 / 新增工具窗不会静默坏掉）', async () => {
    setDisplayMediaMainWebContents(7);
    expect(await request()).toMatchObject({ video: { id: 'screen:1:0' } });
  });

  it('⚠️ 不依赖 frame.name —— 空串也要放行', async () => {
    // 这正是第一版 bug 的形态：frame.name 恒为空串（不是窗口名）。
    mocks.frame = { name: '' };
    expect(await request()).toMatchObject({ video: { id: 'screen:1:0' } });
    // 换个名字同样放行。
    mocks.frame = { name: 'weq-call' };
    expect(await request()).toMatchObject({ video: { id: 'screen:1:0' } });
  });

  it('没有可用 screen 源时拒绝', async () => {
    mocks.sources = [];
    expect(await request()).toBeNull();
  });

  it('只请求音频时不附带 loopback（非 Windows）', async () => {
    const streams = await request({ video: false, audio: true });
    // 非 Windows 上 loopback 不可用，只给视频轨（Chromium 要求至少有一条）。
    if (process.platform === 'win32') {
      expect(streams).toMatchObject({ audio: 'loopback' });
    } else {
      expect(streams).toMatchObject({ video: { id: 'screen:1:0' } });
      expect(streams).not.toMatchObject({ audio: 'loopback' });
    }
  });
});
