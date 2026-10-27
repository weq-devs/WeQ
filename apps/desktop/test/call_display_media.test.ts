// @vitest-environment node
/**
 * 屏幕共享放行 handler。
 *
 * ## 这里钉住的是花了三轮才定位的真机 bug（2026-10-28）
 *
 * 报错长这样，**极具误导性**：
 *
 * ```
 * AbortError: Invalid capture constraints
 * ```
 *
 * 它跟分辨率 / 帧率约束毫无关系 —— 对照实验：handler 回 `null` 就报这个错，
 * 正常放行则一切正常。所以第一轮去改渲染层约束（加 `max`、试 `exact`）全是白费。
 *
 * 真因是「按窗口身份拦截调用方」这个思路本身就是错的。真机诊断日志：
 *
 * ```text
 * ownerId: 1, mainId: 1, frameName: "",
 * frameUrl: "http://localhost:5173/", frameParent: "top",
 * windowIds: [2, 1]
 * ```
 *
 * `frameUrl` 是**主窗口**的地址。原因：`CallWindow` 用 `createPortal` 把 DOM 渲染
 * 进 `popup.document` —— DOM 在子窗口里，**JS 执行上下文仍属于主窗口**，所以
 * `navigator.mediaDevices` 是主窗口那一份，请求只能从主窗口发出。
 *
 * | 判断方式 | 结果 |
 * | --- | --- |
 * | `frame.name === 'weq-call'` | ❌ 实测恒为空串，每次都拒 |
 * | `owner.id !== 主窗口 id` | ❌ 请求本来就来自主窗口，每次都拒 |
 * | **不按窗口拦截** | ✅ |
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  frame: null as null | { name: string; url: string },
  owner: null as null | { id: number },
  sources: [] as Array<{ id: string; name: string }>,
  handler: null as null | ((request: unknown, callback: (s: unknown) => void) => Promise<void>),
  getSources: null as null | (() => Promise<Array<{ id: string; name: string }>>),
}));

vi.mock('electron', () => ({
  desktopCapturer: {
    getSources: vi.fn(() => (mocks.getSources ?? (async () => mocks.sources))()),
  },
  session: { defaultSession: {} },
  webContents: { fromFrame: () => mocks.owner },
}));

vi.mock('@weq/service', () => ({
  getLogger: () => ({
    child: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  }),
}));

import { installCallDisplayMediaHandler } from '../src/main/call_display_media';

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

async function request(options: { video?: boolean; audio?: boolean } = {}): Promise<unknown> {
  let received: unknown = 'NOT_CALLED';
  await mocks.handler!(
    {
      frame: mocks.frame,
      videoRequested: options.video ?? true,
      audioRequested: options.audio ?? false,
      securityOrigin: 'http://localhost:5173',
      userGesture: true,
    },
    (streams) => {
      received = streams;
    },
  );
  return received;
}

beforeEach(() => {
  // 真机诊断里的原样形态：主窗口地址、空 frame name、owner 就是主窗口。
  mocks.frame = { name: '', url: 'http://localhost:5173/' };
  mocks.owner = { id: 1 };
  mocks.sources = [{ id: 'screen:1:0', name: '整个屏幕' }];
  mocks.getSources = null;
  captureHandler();
});

describe('屏幕共享放行', () => {
  it('⚠️ 请求来自主窗口（createPortal 的真实形态）也要放行', async () => {
    // 这正是第一版 bug 的现场：owner 是主窗口、frame.name 是空串。
    expect(await request()).toMatchObject({ video: { id: 'screen:1:0' } });
  });

  it('frame 为空（请求方已销毁）时拒绝', async () => {
    mocks.frame = null;
    expect(await request()).toBeNull();
  });

  it('没有可用 screen 源时拒绝', async () => {
    mocks.sources = [];
    expect(await request()).toBeNull();
  });

  it('取源抛错时拒绝，不把异常漏给渲染层', async () => {
    mocks.getSources = () => Promise.reject(new Error('portal 崩了'));
    expect(await request()).toBeNull();
  });

  it('只请求音频时不附带 loopback（非 Windows）', async () => {
    const streams = await request({ video: false, audio: true });
    if (process.platform === 'win32') {
      expect(streams).toMatchObject({ audio: 'loopback' });
    } else {
      expect(streams).toMatchObject({ video: { id: 'screen:1:0' } });
      expect(streams).not.toMatchObject({ audio: 'loopback' });
    }
  });

  it('既不请求视频也不请求音频时拒绝', async () => {
    expect(await request({ video: false, audio: false })).toBeNull();
  });
});
