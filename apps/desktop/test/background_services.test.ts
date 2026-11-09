// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 各 runtime 的状态函数都 mock 掉 —— 这个模块的职责只是「把六个信号汇总成
 * 一个名单」，不该连带把真实服务拉起来。
 */
const state = vi.hoisted(() => ({
  mcp: false,
  onebot: false,
  assistant: false,
  web: false,
  remote: false,
  sse: false,
  webThrows: false,
}));

vi.mock('../src/main/mcp/server', () => ({ isMcpRunning: () => state.mcp }));
vi.mock('../src/main/onebot/runtime', () => ({
  oneBotStatus: () => ({ running: state.onebot, clients: 0 }),
}));
vi.mock('../src/main/weq_assistant/server', () => ({
  assistantResourceServer: { status: () => ({ running: state.assistant, port: 27182 }) },
}));
vi.mock('../src/main/web/runtime', () => ({
  desktopWebRuntime: {
    status: () => {
      if (state.webThrows) throw new Error('web runtime not ready');
      return { enabled: state.web };
    },
  },
}));
vi.mock('../src/main/remote/runtime', () => ({
  remoteRuntime: { status: () => ({ enabled: state.remote }) },
}));
vi.mock('../src/main/context/app_context', () => ({
  isSsePushActive: () => state.sse,
}));

const backgroundServices = await import('../src/main/background_services');
const { backgroundServicesRunning } = backgroundServices;

beforeEach(() => {
  state.mcp = false;
  state.onebot = false;
  state.assistant = false;
  state.web = false;
  state.remote = false;
  state.sse = false;
  state.webThrows = false;
});

describe('当前运行中的后台服务', () => {
  it('全部关闭时返回空数组', () => {
    expect(backgroundServicesRunning()).toEqual([]);
  });

  it('按固定顺序列出运行中的服务，未运行的跳过', () => {
    state.mcp = true;
    state.assistant = true;
    state.sse = true;
    expect(backgroundServicesRunning()).toEqual([
      { id: 'mcp', label: 'MCP 服务器' },
      { id: 'assistant', label: 'QQ 公众号推送' },
      { id: 'sse', label: 'SSE 消息推送' },
    ]);
  });

  it('六个信号各自独立生效', () => {
    for (const key of ['mcp', 'onebot', 'assistant', 'web', 'remote', 'sse'] as const) {
      state[key] = true;
      expect(backgroundServicesRunning().map((s) => s.id)).toEqual([key]);
      state[key] = false;
    }
  });

  it('某个状态函数抛错时当作没在跑，不影响其余服务', () => {
    state.mcp = true;
    state.web = true;
    state.remote = true;
    state.webThrows = true;
    expect(backgroundServicesRunning().map((s) => s.id)).toEqual(['mcp', 'remote']);
  });
});

describe('退出不再经过确认', () => {
  it('模块不再提供「退出前是否需要确认」的判据', () => {
    // 回归守卫：Dock / Cmd+Q / 托盘退出必须直通。若有人把确认逻辑加回来，
    // 这个用例会失败，提醒同时更新关窗确认框与文档，而不是悄悄拦掉退出。
    expect('needsQuitConfirmation' in backgroundServices).toBe(false);
  });
});
